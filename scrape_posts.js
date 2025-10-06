import fetch from 'node-fetch';
import { writeFile, mkdir, readFile } from 'fs/promises';
import { join } from 'path';

// ============================================================================
// Instagram Post Scraper - Get Detailed Post Information
// ============================================================================
// NOTE: This version uses direct HTTP requests which Instagram blocks.
// To scrape posts successfully, this needs to be updated to use Puppeteer
// for browser automation. Instagram detects and blocks automated requests.
// ============================================================================

/**
 * Extract detailed information from a single Instagram post
 * @param {string} postUrl - The Instagram post URL
 * @returns {Promise<object>} Post details
 */
async function scrapePost(postUrl) {
    console.log(`\n📸 Scraping: ${postUrl}`);
    
    // Extract shortcode from URL
    const shortcodeMatch = postUrl.match(/\/p\/([A-Za-z0-9_-]+)\//);
    if (!shortcodeMatch) {
        throw new Error(`Invalid Instagram post URL: ${postUrl}`);
    }
    const shortcode = shortcodeMatch[1];

    // Fetch the HTML page and extract embedded JSON
    const response = await fetch(postUrl, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept-Encoding': 'gzip, deflate, br'
        }
    });

    if (!response.ok) {
        throw new Error(`Instagram returned status ${response.status} for ${postUrl}`);
    }

    const html = await response.text();
    
    // Extract JSON data from script tag
    const scriptRegex = /<script type="application\/ld\+json">({.+?})<\/script>/;
    const match = html.match(scriptRegex);
    
    let ldJson = null;
    if (match) {
        ldJson = JSON.parse(match[1]);
    }

    // Also try to extract from window._sharedData
    const sharedDataRegex = /window\._sharedData = ({.+?});<\/script>/;
    const sharedMatch = html.match(sharedDataRegex);
    
    let sharedData = null;
    if (sharedMatch) {
        sharedData = JSON.parse(sharedMatch[1]);
    }

    // Try another pattern for newer Instagram pages
    const additionalDataRegex = /<script type="application\/json" data-content-len="\d+" data-sjs>({.+?})<\/script>/;
    const additionalMatch = html.match(additionalDataRegex);
    
    let additionalData = null;
    if (additionalMatch) {
        additionalData = JSON.parse(additionalMatch[1]);
    }

    // Find the post data in various possible locations
    let item = null;
    
    // Try to find in sharedData
    if (sharedData?.entry_data?.PostPage?.[0]?.graphql?.shortcode_media) {
        item = sharedData.entry_data.PostPage[0].graphql.shortcode_media;
    }
    
    // Try to find in additionalData
    if (!item && additionalData) {
        // Navigate through the nested structure
        const findMedia = (obj) => {
            if (!obj || typeof obj !== 'object') return null;
            
            if (obj.shortcode === shortcode || obj.code === shortcode) {
                return obj;
            }
            
            for (const key in obj) {
                if (key === 'xdt_shortcode_media' || key === 'shortcode_media') {
                    return obj[key];
                }
                const result = findMedia(obj[key]);
                if (result) return result;
            }
            return null;
        };
        
        item = findMedia(additionalData);
    }
    
    if (!item) {
        throw new Error(`No post data found for ${postUrl}`);
    }

    // Determine the structure (GraphQL vs other formats)
    const isGraphQL = item.__typename !== undefined;
    
    // Extract post type
    let postType = 'photo';
    let isReel = false;
    
    if (isGraphQL) {
        if (item.__typename === 'GraphVideo') {
            postType = 'video';
            isReel = item.is_video === true && item.product_type === 'clips';
            if (isReel) postType = 'reel';
        } else if (item.__typename === 'GraphSidecar') {
            postType = 'carousel';
        } else if (item.__typename === 'GraphImage') {
            postType = 'photo';
        }
    } else {
        const mediaType = item.media_type;
        if (mediaType === 2) postType = 'video';
        else if (mediaType === 8) postType = 'carousel';
        isReel = item.product_type === 'clips' || (item.media_type === 2 && item.product_type === 'clips');
        if (isReel && mediaType === 2) postType = 'reel';
    }

    // Extract caption and hashtags
    let caption = '';
    if (isGraphQL) {
        caption = item.edge_media_to_caption?.edges?.[0]?.node?.text || '';
    } else {
        caption = item.caption?.text || '';
    }
    const hashtags = extractHashtags(caption);
    const mentions = extractMentions(caption);

    // Extract location
    let location = null;
    if (item.location) {
        location = {
            id: item.location.pk || item.location.id,
            name: item.location.name,
            address: item.location.address || null,
            city: item.location.city || null,
            lat: item.location.lat || null,
            lng: item.location.lng || null
        };
    }

    // Extract engagement metrics
    let likeCount = 0;
    let commentCount = 0;
    let viewCount = null;
    let videoViewCount = null;

    if (isGraphQL) {
        likeCount = item.edge_media_preview_like?.count || item.edge_liked_by?.count || 0;
        commentCount = item.edge_media_to_comment?.count || item.edge_media_to_parent_comment?.count || 0;
        viewCount = item.video_view_count || null;
        videoViewCount = item.video_view_count || null;
    } else {
        likeCount = item.like_count || 0;
        commentCount = item.comment_count || 0;
        viewCount = item.play_count || item.view_count || null;
        videoViewCount = item.video_view_count || null;
    }

    // Extract media URLs
    const mediaUrls = [];
    if (isGraphQL) {
        if (item.edge_sidecar_to_children) {
            // Carousel
            item.edge_sidecar_to_children.edges.forEach(edge => {
                const media = edge.node;
                mediaUrls.push({
                    type: media.is_video ? 'video' : 'image',
                    url: media.is_video ? media.video_url : media.display_url
                });
            });
        } else {
            // Single media
            mediaUrls.push({
                type: item.is_video ? 'video' : 'image',
                url: item.is_video ? item.video_url : item.display_url
            });
        }
    } else {
        if (item.carousel_media) {
            item.carousel_media.forEach(media => {
                mediaUrls.push({
                    type: media.media_type === 2 ? 'video' : 'image',
                    url: media.media_type === 2 
                        ? media.video_versions?.[0]?.url 
                        : media.image_versions2?.candidates?.[0]?.url
                });
            });
        } else {
            const mediaType = item.media_type;
            mediaUrls.push({
                type: mediaType === 2 ? 'video' : 'image',
                url: mediaType === 2 
                    ? item.video_versions?.[0]?.url 
                    : item.image_versions2?.candidates?.[0]?.url || item.display_url
            });
        }
    }

    // Extract owner info
    let owner = {};
    if (isGraphQL) {
        owner = {
            username: item.owner?.username,
            full_name: item.owner?.full_name,
            profile_pic_url: item.owner?.profile_pic_url,
            is_verified: item.owner?.is_verified || false,
            is_private: item.owner?.is_private || false,
            id: item.owner?.id
        };
    } else {
        owner = {
            username: item.user?.username,
            full_name: item.user?.full_name,
            profile_pic_url: item.user?.profile_pic_url,
            is_verified: item.user?.is_verified || false,
            is_private: item.user?.is_private || false,
            id: item.user?.pk || item.user?.id
        };
    }

    // Extract timestamp
    let takenAt = null;
    let takenAtTimestamp = null;
    if (isGraphQL) {
        takenAtTimestamp = item.taken_at_timestamp;
        takenAt = new Date(takenAtTimestamp * 1000).toISOString();
    } else {
        takenAtTimestamp = item.taken_at;
        takenAt = new Date(takenAtTimestamp * 1000).toISOString();
    }

    // Build the result
    const result = {
        shortcode: shortcode,
        url: postUrl,
        post_type: postType,
        is_reel: isReel,
        
        // Datetime
        taken_at: takenAt,
        taken_at_timestamp: takenAtTimestamp,
        
        // Caption and text content
        caption: caption,
        hashtags: hashtags,
        mentions: mentions,
        
        // Location
        location: location,
        
        // Engagement metrics
        like_count: likeCount,
        comment_count: commentCount,
        play_count: viewCount,
        video_view_count: videoViewCount,
        
        // Media
        media_count: mediaUrls.length,
        media_urls: mediaUrls,
        
        // Owner
        owner: owner,
        
        // Additional metadata
        accessibility_caption: item.accessibility_caption || ldJson?.caption || null,
        is_paid_partnership: item.is_paid_partnership || false,
        has_audio: item.has_audio || null,
        music_metadata: item.music_metadata || null,
        
        // Metadata from LD+JSON if available
        ...(ldJson && {
            ld_json_author: ldJson.author?.identifier?.value || ldJson.author?.alternateName,
            ld_json_description: ldJson.articleBody || ldJson.description,
            ld_json_upload_date: ldJson.uploadDate
        })
    };

    console.log(`   ✅ ${postType.toUpperCase()} | ❤️  ${likeCount.toLocaleString()} | 💬 ${commentCount.toLocaleString()}${viewCount ? ` | 👁️  ${viewCount.toLocaleString()}` : ''}`);
    
    return result;
}

/**
 * Extract hashtags from text
 */
function extractHashtags(text) {
    if (!text) return [];
    const hashtagRegex = /#[\w\u0590-\u05ff]+/g;
    const matches = text.match(hashtagRegex) || [];
    return matches.map(tag => tag.substring(1)); // Remove # prefix
}

/**
 * Extract mentions from text
 */
function extractMentions(text) {
    if (!text) return [];
    const mentionRegex = /@[\w.]+/g;
    const matches = text.match(mentionRegex) || [];
    return matches.map(mention => mention.substring(1)); // Remove @ prefix
}

/**
 * Scrape multiple posts from URLs
 * @param {string[]} urls - Array of Instagram post URLs
 * @param {object} options - Options for scraping
 * @returns {Promise<object>} Results
 */
async function scrapePosts(urls, options = {}) {
    const { delay = 2000, continueOnError = true } = options;
    
    console.log(`\n🎯 Scraping ${urls.length} posts...`);
    console.log(`⏱️  Delay between requests: ${delay}ms`);
    console.log(`🔄 Continue on error: ${continueOnError ? 'Yes' : 'No'}\n`);

    const results = [];
    const errors = [];

    for (let i = 0; i < urls.length; i++) {
        const url = urls[i];
        
        try {
            const postData = await scrapePost(url);
            results.push(postData);
            
            // Add delay between requests to avoid rate limiting
            if (i < urls.length - 1) {
                console.log(`   ⏳ Waiting ${delay}ms before next request...`);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        } catch (error) {
            console.error(`   ❌ Error scraping ${url}: ${error.message}`);
            errors.push({ url, error: error.message });
            
            if (!continueOnError) {
                throw error;
            }
        }
    }

    return {
        posts: results,
        total_scraped: results.length,
        total_errors: errors.length,
        errors: errors,
        scraped_at: new Date().toISOString()
    };
}

/**
 * Load URLs from a JSON file
 */
async function loadUrlsFromFile(filePath) {
    console.log(`📂 Loading URLs from: ${filePath}`);
    const content = await readFile(filePath, 'utf-8');
    const data = JSON.parse(content);
    
    if (data.post_urls && Array.isArray(data.post_urls)) {
        console.log(`   ✅ Found ${data.post_urls.length} URLs`);
        return {
            urls: data.post_urls,
            username: data.username
        };
    }
    
    throw new Error('Invalid URL file format. Expected { post_urls: [...] }');
}

/**
 * Save scraped posts to JSON file
 */
async function savePosts(result, username = 'posts', filenameSuffix = '') {
    const postsDir = join(process.cwd(), 'posts');
    await mkdir(postsDir, { recursive: true });

    const suffix = filenameSuffix || Date.now();
    const outputFileName = `posts_${username}_${suffix}.json`;
    const outputPath = join(postsDir, outputFileName);
    
    await writeFile(outputPath, JSON.stringify(result, null, 2));
    console.log(`\n💾 Saved: ${outputPath}`);
    return outputPath;
}

// ============================================================================
// Main
// ============================================================================

const args = process.argv.slice(2);

// Usage modes:
// 1. node scrape_posts.js <url_file.json> [delay_ms]
// 2. node scrape_posts.js <single_url> [delay_ms]

if (args.length === 0) {
    console.error('❌ Usage:');
    console.error('   Mode 1 (from URL file): node scrape_posts.js <url_file.json> [delay_ms]');
    console.error('   Mode 2 (single URL):    node scrape_posts.js <instagram_url> [delay_ms]');
    console.error('\n   Examples:');
    console.error('   node scrape_posts.js ./post-urls/urls_psv_123456.json 2000');
    console.error('   node scrape_posts.js https://www.instagram.com/p/ABC123/ 2000');
    process.exit(1);
}

const input = args[0];
const delay = args[1] ? parseInt(args[1]) : 2000;

(async () => {
    try {
        let urls, username;

        // Check if input is a file or a URL
        if (input.endsWith('.json')) {
            // Mode 1: Load from file
            const loaded = await loadUrlsFromFile(input);
            urls = loaded.urls;
            username = loaded.username;
        } else if (input.includes('instagram.com')) {
            // Mode 2: Single URL
            urls = [input];
            username = 'single';
        } else {
            throw new Error('Invalid input. Provide either a JSON file path or an Instagram URL.');
        }

        // Scrape the posts
        const result = await scrapePosts(urls, { delay, continueOnError: true });

        // Add username to result
        if (username) {
            result.username = username;
        }

        // Print summary
        console.log('\n' + '='.repeat(80));
        console.log('📊 SCRAPING SUMMARY');
        console.log('='.repeat(80));
        console.log(`✅ Successfully scraped: ${result.total_scraped} posts`);
        console.log(`❌ Errors: ${result.total_errors}`);
        
        if (result.posts.length > 0) {
            console.log(`\n📈 ENGAGEMENT STATISTICS:`);
            const totalLikes = result.posts.reduce((sum, p) => sum + (p.like_count || 0), 0);
            const totalComments = result.posts.reduce((sum, p) => sum + (p.comment_count || 0), 0);
            const avgLikes = Math.round(totalLikes / result.posts.length);
            const avgComments = Math.round(totalComments / result.posts.length);
            
            console.log(`   Total Likes: ${totalLikes.toLocaleString()}`);
            console.log(`   Total Comments: ${totalComments.toLocaleString()}`);
            console.log(`   Average Likes: ${avgLikes.toLocaleString()}`);
            console.log(`   Average Comments: ${avgComments.toLocaleString()}`);

            // Count post types
            const postTypes = {};
            result.posts.forEach(p => {
                postTypes[p.post_type] = (postTypes[p.post_type] || 0) + 1;
            });
            console.log(`\n📸 POST TYPES:`);
            Object.entries(postTypes).forEach(([type, count]) => {
                console.log(`   ${type}: ${count}`);
            });

            // Show posts with locations
            const withLocation = result.posts.filter(p => p.location).length;
            if (withLocation > 0) {
                console.log(`\n📍 Posts with location: ${withLocation}`);
            }
        }

        if (result.errors.length > 0) {
            console.log(`\n❌ ERRORS:`);
            result.errors.forEach((err, i) => {
                console.log(`   ${i + 1}. ${err.url}: ${err.error}`);
            });
        }

        // Save results
        await savePosts(result, username);

        console.log('\n✅ Done!\n');
        
    } catch (error) {
        console.error(`\n❌ Fatal Error: ${error.message}`);
        console.error(error.stack);
        process.exit(1);
    }
})();
