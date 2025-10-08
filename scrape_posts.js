import puppeteer from 'puppeteer';
import { writeFile, mkdir, readFile, access } from 'fs/promises';
import { join } from 'path';
import { constants } from 'fs';

const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function scrapePost(page, postUrl) {
    console.log(`\n📸 Scraping: ${postUrl}`);
    await page.goto(postUrl, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await wait(8000);
    
    const postData = await page.evaluate(() => {
        function extractHashtags(text) {
            if (!text) return [];
            const matches = text.match(/#[\w\u0590-\u05ff]+/g) || [];
            return matches.map(tag => tag.substring(1));
        }
        
        function extractMentions(text) {
            if (!text) return [];
            const matches = text.match(/@[\w.]+/g) || [];
            return matches.map(mention => mention.substring(1));
        }
        
        const scripts = Array.from(document.querySelectorAll('script[type="application/json"]'));
        let postInfo = null;
        
        for (const script of scripts) {
            try {
                const data = JSON.parse(script.textContent);
                
                // Direct path to media data: require[0][3][0].__bbox.require[0][3][1].__bbox.result.data.xdt_api__v1__media__shortcode__web_info.items[0]
                const media = data?.require?.[0]?.[3]?.[0]?.__bbox?.require?.[0]?.[3]?.[1]?.__bbox?.result?.data?.xdt_api__v1__media__shortcode__web_info?.items?.[0];
                
                if (media && media.code) {
                    postInfo = media;
                    break;
                }
            } catch (e) {}
        }
        
        if (postInfo) {
            const caption = postInfo.caption?.text || '';
            const isVideo = postInfo.media_type === 2;
            const isCarousel = postInfo.carousel_media_count > 1;
            
            return {
                shortcode: postInfo.code,
                post_type: postInfo.product_type === 'clips' ? 'reel' :
                           isCarousel ? 'carousel' : 
                           isVideo ? 'video' : 'photo',
                is_reel: postInfo.product_type === 'clips',
                taken_at: new Date(postInfo.taken_at * 1000).toISOString(),
                taken_at_timestamp: postInfo.taken_at,
                caption: caption,
                hashtags: extractHashtags(caption),
                mentions: extractMentions(caption),
                location: postInfo.location ? {
                    id: postInfo.location.id,
                    name: postInfo.location.name,
                    address: postInfo.location.address || null,
                    city: postInfo.location.city || null,
                    latitude: postInfo.location.lat || null,
                    longitude: postInfo.location.lng || null
                } : null,
                like_count: postInfo.like_count || 0,
                comment_count: postInfo.comment_count || 0,
                video_view_count: postInfo.view_count || null,
                media_count: postInfo.carousel_media_count || 1,
                owner: {
                    username: postInfo.user?.username || postInfo.owner?.username,
                    full_name: postInfo.user?.full_name || postInfo.owner?.full_name || null,
                    is_verified: postInfo.user?.is_verified || postInfo.owner?.is_verified || false,
                    is_private: postInfo.user?.is_private || postInfo.owner?.is_private || false
                },
                accessibility_caption: postInfo.accessibility_caption || null,
                is_paid_partnership: postInfo.is_paid_partnership || false,
                from_api: true
            };
        }
        
        // Fallback if we can't find the JSON data
        return {
            shortcode: window.location.pathname.split('/')[2],
            caption: '',
            from_api: false,
            error: 'Could not extract data from page'
        };
    });
    
    postData.url = postUrl;
    const likes = postData.like_count ? postData.like_count.toLocaleString() : 'N/A';
    const comments = postData.comment_count ? postData.comment_count.toLocaleString() : 'N/A';
    console.log(`   ✅ ${postData.post_type?.toUpperCase() || 'POST'} | ❤️  ${likes} | 💬 ${comments}`);
    return postData;
}

async function scrapePosts(urls, options = {}) {
    const { delay = 3000, headless = true } = options;
    
    // Remove duplicate URLs before scraping
    const uniqueUrls = [...new Set(urls)];
    if (uniqueUrls.length < urls.length) {
        console.log(`ℹ️  Removed ${urls.length - uniqueUrls.length} duplicate URL(s)`);
    }
    
    console.log(`\n⟏ Scraping ${uniqueUrls.length} unique posts...`);
    console.log('🚀 Launching browser...');
    
    const browser = await puppeteer.launch({
        headless: headless,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    
    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    
    const results = [];
    const seenShortcodes = new Set(); // Track shortcodes to prevent duplicates
    const errors = [];
    
    try {
        for (let i = 0; i < uniqueUrls.length; i++) {
            try {
                const postData = await scrapePost(page, uniqueUrls[i]);
                
                // Check for duplicate shortcode
                if (seenShortcodes.has(postData.shortcode)) {
                    console.log(`   ⚠️  Skipping duplicate post: ${postData.shortcode}`);
                    continue;
                }
                
                seenShortcodes.add(postData.shortcode);
                results.push(postData);
                
                if (i < uniqueUrls.length - 1) {
                    console.log(`   ⏳ Waiting ${delay}ms...`);
                    await wait(delay);
                }
            } catch (error) {
                console.error(`   ❌ Error: ${error.message}`);
                errors.push({ url: uniqueUrls[i], error: error.message });
            }
        }
    } finally {
        console.log('\n🔒 Closing browser...');
        await browser.close();
    }
    
    return {
        posts: results,
        total_scraped: results.length,
        total_errors: errors.length,
        errors: errors,
        scraped_at: new Date().toISOString()
    };
}

async function loadUrlsFromFile(filePath) {
    const content = await readFile(filePath, 'utf-8');
    const data = JSON.parse(content);
    return { urls: data.post_urls, username: data.username };
}

async function loadExistingPosts(filePath) {
    try {
        await access(filePath, constants.F_OK);
        const content = await readFile(filePath, 'utf-8');
        return JSON.parse(content);
    } catch (error) {
        return null; // File doesn't exist
    }
}

async function savePosts(result, username) {
    const postsDir = join(process.cwd(), 'posts');
    await mkdir(postsDir, { recursive: true });
    
    // Use consistent filename without timestamp
    const outputPath = join(postsDir, `posts_${username}.json`);
    
    // Load existing data if file exists
    const existing = await loadExistingPosts(outputPath);
    
    if (existing) {
        console.log(`\n📂 Found existing file with ${existing.posts.length} posts`);
        
        // Merge posts and deduplicate by shortcode
        const allPostsMap = new Map();
        
        // Add existing posts
        existing.posts.forEach(post => {
            if (post.shortcode) {
                allPostsMap.set(post.shortcode, post);
            }
        });
        
        // Add/update with new posts
        let newCount = 0;
        let updatedCount = 0;
        result.posts.forEach(post => {
            if (post.shortcode) {
                if (allPostsMap.has(post.shortcode)) {
                    // Post exists, update it
                    allPostsMap.set(post.shortcode, post);
                    updatedCount++;
                } else {
                    // New post
                    allPostsMap.set(post.shortcode, post);
                    newCount++;
                }
            }
        });
        
        const mergedPosts = Array.from(allPostsMap.values());
        
        if (newCount > 0) {
            console.log(`   ➕ Added ${newCount} new post(s)`);
        }
        if (updatedCount > 0) {
            console.log(`   🔄 Updated ${updatedCount} existing post(s)`);
        }
        if (newCount === 0 && updatedCount === 0) {
            console.log(`   ℹ️  No new posts found (all already existed)`);
        }
        console.log(`   📊 Total unique posts: ${mergedPosts.length}`);
        
        // Update result with merged data
        result.posts = mergedPosts;
        result.total_scraped = mergedPosts.length;
        
        // Merge errors (keep unique)
        const allErrors = [...(existing.errors || []), ...(result.errors || [])];
        result.errors = allErrors;
        result.total_errors = allErrors.length;
        
        result.last_updated = new Date().toISOString();
        result.first_scraped = existing.scraped_at || existing.first_scraped;
    } else {
        console.log(`\n📝 Creating new posts file`);
        result.first_scraped = result.scraped_at;
        result.last_updated = result.scraped_at;
    }
    
    await writeFile(outputPath, JSON.stringify(result, null, 2));
    console.log(`💾 Saved: ${outputPath}`);
}

const args = process.argv.slice(2);
if (args.length === 0) {
    console.error('Usage: node scrape_posts.js <url_file.json> [delay_ms] [--show-browser]');
    process.exit(1);
}

const inputFile = args[0];
const delay = args[1] && !args[1].startsWith('--') ? parseInt(args[1]) : 3000;
const showBrowser = args.includes('--show-browser');

(async () => {
    try {
        const { urls, username } = await loadUrlsFromFile(inputFile);
        const result = await scrapePosts(urls, { delay, headless: !showBrowser });
        result.username = username;
        
        console.log(`\n✅ Successfully scraped: ${result.total_scraped} posts`);
        if (result.total_errors > 0) {
            console.log(`❌ Errors: ${result.total_errors}`);
        }
        
        await savePosts(result, username);
    } catch (error) {
        console.error(`\n❌ Fatal error: ${error.message}`);
        process.exit(1);
    }
})();
