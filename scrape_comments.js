import fetch from 'node-fetch';
import { writeFile, mkdir, readFile, access } from 'fs/promises';
import { join, isAbsolute, basename } from 'path';
import { constants } from 'fs';
import 'dotenv/config';

const SESSION = process.env.SESSION;
const COMMENTS_QUERY_HASH = 'bc3296d1ce80a24b1b6e40b1e72903f5';

if (!SESSION) {
    throw new Error('SESSION environment variable is required in .env file');
}

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
    const seenCommentIds = new Set(); // Track unique comment IDs to prevent duplicates
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
            
            // Filter out duplicates based on comment ID
            const uniqueComments = parsed.filter(comment => {
                if (seenCommentIds.has(comment.id)) {
                    return false;
                }
                seenCommentIds.add(comment.id);
                return true;
            });
            
            allComments.push(...uniqueComments);
            
            console.log(`   ✓ Fetched ${uniqueComments.length} unique comment(s)`);
            
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

async function loadExistingComments(filePath) {
    try {
        await access(filePath, constants.F_OK);
        const content = await readFile(filePath, 'utf-8');
        return JSON.parse(content);
    } catch (error) {
        return null; // File doesn't exist
    }
}

async function saveComments(result, filename = null) {
    const commentsDir = join(process.cwd(), 'comments');
    await mkdir(commentsDir, { recursive: true });

    // Use consistent filename without timestamp
    const outputFileName = filename
        ? (isAbsolute(filename) ? basename(filename) : filename)
        : `comments_${result.shortcode}.json`;

    const outputPath = join(commentsDir, outputFileName);
    const existing = await loadExistingComments(outputPath);
    
    if (existing) {
        console.log(`\n📂 Found existing file with ${existing.length} comments`);
        const allCommentsMap = new Map();
        existing.forEach(comment => {
            allCommentsMap.set(comment.id, comment);
        });
        
        let newCount = 0;
        let updatedCount = 0;
        result.comments.forEach(comment => {
            if (allCommentsMap.has(comment.id)) {
                allCommentsMap.set(comment.id, comment);
                updatedCount++;
            } else {
                allCommentsMap.set(comment.id, comment);
                newCount++;
            }
        });
        
        const mergedComments = Array.from(allCommentsMap.values());
        
        if (newCount > 0) {
            console.log(`   ➕ Added ${newCount} new comment(s)`);
        }
        if (updatedCount > 0) {
            console.log(`   🔄 Updated ${updatedCount} existing comment(s)`);
        }
        if (newCount === 0 && updatedCount === 0) {
            console.log(`   ℹ️  No new comments found`);
        }
        console.log(`   📊 Total unique comments: ${mergedComments.length}`);
        result.comments = mergedComments;
        result.totalFetched = mergedComments.length;
    } else {
        console.log(`\n📝 Creating new comments file`);
    }

    await writeFile(outputPath, JSON.stringify(result.comments, null, 2));
    console.log(`💾 Saved: ${outputPath}`);
    return outputPath;
}

async function loadPostUrls(filePath) {
    try {
        const content = await readFile(filePath, 'utf-8');
        const data = JSON.parse(content);
        return data.post_urls || [];
    } catch (error) {
        throw new Error(`Failed to load post URLs from ${filePath}: ${error.message}`);
    }
}

async function scrapeMultiplePosts(postUrls, maxComments = 1500) {
    console.log(`\n╔═══════════════════════════════════════════════════════════╗`);
    console.log(`║   Instagram Comments Scraper - Batch Mode                ║`);
    console.log(`║   Scraping comments from ${String(postUrls.length).padEnd(2)} posts                        ║`);
    console.log(`╚═══════════════════════════════════════════════════════════╝`);
    
    const results = [];
    
    for (let i = 0; i < postUrls.length; i++) {
        const postUrl = postUrls[i];
        console.log(`\n${'━'.repeat(60)}`);
        console.log(`📍 Post ${i + 1} of ${postUrls.length}`);
        console.log(`${'━'.repeat(60)}`);
        
        try {
            const result = await scrapeAllComments(postUrl, maxComments, 50);
            
            console.log('\n' + '─'.repeat(50));
            console.log('📈 SUMMARY');
            console.log('─'.repeat(50));
            console.log(`Post: ${result.postUrl}`);
            console.log(`Available: ${result.totalAvailable || 'unknown'}`);
            console.log(`Fetched: ${result.totalFetched}`);
            console.log(`Pages: ${result.pages}`);
            
            if (result.comments.length > 0) {
                console.log(`\n📝 Sample:`);
                result.comments.slice(0, 2).forEach((comment, idx) => {
                    console.log(`\n${idx + 1}. @${comment.owner?.username || 'unknown'}`);
                    console.log(`   ${comment.text?.substring(0, 60) || 'no text'}${comment.text?.length > 60 ? '...' : ''}`);
                    console.log(`   ❤️  ${comment.likes} likes`);
                });
                
                await saveComments(result);
            }
            
            results.push({
                shortcode: result.shortcode,
                success: true,
                comments: result.totalFetched
            });
            
            // Delay between posts to avoid rate limiting
            if (i < postUrls.length - 1) {
                console.log(`\n⏳ Waiting 5 seconds before next post...`);
                await new Promise(resolve => setTimeout(resolve, 5000));
            }
            
        } catch (error) {
            console.error(`\n❌ Failed to scrape post: ${error.message}`);
            results.push({
                shortcode: extractShortcode(postUrl),
                success: false,
                error: error.message
            });
        }
    }
    
    return results;
}

const args = process.argv.slice(2);
const urlsFile = args[0];
const maxComments = parseInt(args[1]) || 1500;

if (!urlsFile) {
    console.error('❌ Usage: node scrape_comments.js <urls_file.json> [max_comments]');
    console.error('   Example: node scrape_comments.js post-urls/urls_psv.json 1500');
    console.error('');
    console.error('   The URLs file should be a JSON file with a "post_urls" array.');
    process.exit(1);
}

loadPostUrls(urlsFile)
    .then(async (postUrls) => {
        if (postUrls.length === 0) {
            console.error('❌ No post URLs found in the file');
            process.exit(1);
        }
        
        const results = await scrapeMultiplePosts(postUrls, maxComments);
        
        console.log('\n\n╔═══════════════════════════════════════════════════════════╗');
        console.log('║   BATCH SCRAPING COMPLETE                                ║');
        console.log('╚═══════════════════════════════════════════════════════════╝\n');
        
        const successful = results.filter(r => r.success).length;
        const failed = results.filter(r => !r.success).length;
        const totalComments = results.reduce((sum, r) => sum + (r.comments || 0), 0);
        
        console.log(`✅ Successful: ${successful}/${results.length}`);
        console.log(`❌ Failed: ${failed}/${results.length}`);
        console.log(`💬 Total comments: ${totalComments}`);
        
        if (failed > 0) {
            console.log(`\n⚠️  Failed posts:`);
            results.filter(r => !r.success).forEach(r => {
                console.log(`   • ${r.shortcode}: ${r.error}`);
            });
        }
        
        console.log(`\n✅ All done!`);
    })
    .catch(err => {
        console.error('\n💥 Fatal error:', err.message);
        process.exit(1);
    });
