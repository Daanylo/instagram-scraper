import fetch from 'node-fetch';
import { writeFile, mkdir } from 'fs/promises';
import { join, isAbsolute, basename } from 'path';
import 'dotenv/config';

// ============================================================================
// Configuration
// ============================================================================

const SESSION = process.env.SESSION;
const COMMENTS_QUERY_HASH = 'bc3296d1ce80a24b1b6e40b1e72903f5';

if (!SESSION) {
    throw new Error('SESSION environment variable is required in .env file');
}

// ============================================================================
// Utilities
// ============================================================================

function extractShortcode(postUrl) {
    const match = postUrl.match(/\/p\/([^\/]+)|\/reel\/([^\/]+)/);
    if (!match) throw new Error('Invalid Instagram post URL');
    return match[1] || match[2];
}

function parseComment(edge) {
    const node = edge.node;
    return {
        id: node.id,
        text: node.text,
        created_at: node.created_at,
        owner: {
            id: node.owner?.id,
            username: node.owner?.username,
            is_verified: node.owner?.is_verified,
            profile_pic_url: node.owner?.profile_pic_url
        },
        likes: node.edge_liked_by?.count || 0,
        replies: node.edge_threaded_comments?.count || 0
    };
}

// ============================================================================
// API
// ============================================================================

async function fetchCommentsPage(shortcode, endCursor = '', first = 50) {
    const variables = { shortcode, first, after: endCursor };
    const url = `https://www.instagram.com/graphql/query/?query_hash=${COMMENTS_QUERY_HASH}&variables=${encodeURIComponent(JSON.stringify(variables))}`;

    const response = await fetch(url, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'X-IG-App-ID': '936619743392459',
            'X-Requested-With': 'XMLHttpRequest',
            'Cookie': SESSION,
            'Referer': `https://www.instagram.com/p/${shortcode}/`,
            'Origin': 'https://www.instagram.com'
        }
    });

    if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const data = await response.json();
    const commentData = data.data?.shortcode_media?.edge_media_to_parent_comment;
    
    if (!commentData) {
        throw new Error('Invalid response structure or post not found');
    }

    return {
        comments: commentData.edges || [],
        hasNextPage: commentData.page_info.has_next_page,
        endCursor: commentData.page_info.end_cursor,
        count: commentData.count
    };
}

async function scrapeAllComments(postUrl, maxComments = 1000, pageSize = 50) {
    const shortcode = extractShortcode(postUrl);
    const allComments = [];
    let endCursor = '';
    let hasNextPage = true;
    let pageCount = 0;
    let totalAvailable = 0;

    console.log(`\n🔍 Scraping: ${postUrl}`);
    console.log(`📌 Shortcode: ${shortcode}`);

    try {
        while (hasNextPage && allComments.length < maxComments) {
            pageCount++;
            console.log(`\n📄 Page ${pageCount} (total: ${allComments.length})`);
            
            const result = await fetchCommentsPage(shortcode, endCursor, pageSize);
            
            if (pageCount === 1) {
                totalAvailable = result.count;
                console.log(`📊 Available: ${totalAvailable}`);
            }
            
            const parsed = result.comments.map(parseComment);
            allComments.push(...parsed);
            
            console.log(`   ✓ Fetched ${parsed.length} comments`);
            
            hasNextPage = result.hasNextPage;
            endCursor = result.endCursor;
            
            if (hasNextPage) {
                console.log(`   ⏳ Waiting 2s...`);
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
        }
        
        console.log(`\n✅ Scraped ${allComments.length} of ${totalAvailable} comments`);
        
        return {
            postUrl,
            shortcode,
            totalAvailable,
            totalFetched: allComments.length,
            comments: allComments,
            pages: pageCount
        };
        
    } catch (error) {
        console.error(`\n❌ Error: ${error.message}`);
        
        if (allComments.length > 0) {
            console.log(`⚠️  Returning ${allComments.length} comments before error`);
            return {
                postUrl,
                shortcode,
                totalFetched: allComments.length,
                comments: allComments,
                pages: pageCount,
                error: error.message
            };
        }
        
        throw error;
    }
}

async function saveComments(result, filename = null) {
    const commentsDir = join(process.cwd(), 'comments');
    await mkdir(commentsDir, { recursive: true });

    const outputFileName = filename
        ? (isAbsolute(filename) ? basename(filename) : filename)
        : `comments_${result.shortcode}_${Date.now()}.json`;

    const outputPath = join(commentsDir, outputFileName);
    await writeFile(outputPath, JSON.stringify(result.comments, null, 2));
    console.log(`\n💾 Saved: ${outputPath}`);
    return outputPath;
}

// ============================================================================
// Main
// ============================================================================

const POST_URL = 'https://www.instagram.com/p/DPeGrDmjA9R';

scrapeAllComments(POST_URL, 1500, 30)
    .then(async (result) => {
        console.log('\n' + '='.repeat(50));
        console.log('📈 SUMMARY');
        console.log('='.repeat(50));
        console.log(`Post: ${result.postUrl}`);
        console.log(`Available: ${result.totalAvailable || 'unknown'}`);
        console.log(`Fetched: ${result.totalFetched}`);
        console.log(`Pages: ${result.pages}`);
        
        if (result.comments.length > 0) {
            console.log(`\n📝 Sample:`);
            result.comments.slice(0, 3).forEach((comment, i) => {
                console.log(`\n${i + 1}. @${comment.owner?.username || 'unknown'}`);
                console.log(`   ${comment.text?.substring(0, 80) || 'no text'}${comment.text?.length > 80 ? '...' : ''}`);
                console.log(`   ❤️  ${comment.likes} likes`);
            });
            
            await saveComments(result);
        }
    })
    .catch(err => {
        console.error('\n💥 Fatal error:', err);
        process.exit(1);
    });
