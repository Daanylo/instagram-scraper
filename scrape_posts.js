import puppeteer from 'puppeteer';
import { writeFile, mkdir, readFile } from 'fs/promises';
import { join } from 'path';

// Helper function to wait/delay
const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function scrapePost(page, postUrl) {
    console.log(`\n📸 Scraping: ${postUrl}`);
    await page.goto(postUrl, { waitUntil: 'networkidle2', timeout: 30000 });
    await wait(3000); // Wait longer for dynamic content
    
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
    console.log(`\n⟏ Scraping ${urls.length} posts...`);
    console.log('🚀 Launching browser...');
    
    const browser = await puppeteer.launch({
        headless: headless,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    
    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    
    const results = [];
    const errors = [];
    
    try {
        for (let i = 0; i < urls.length; i++) {
            try {
                const postData = await scrapePost(page, urls[i]);
                results.push(postData);
                
                if (i < urls.length - 1) {
                    console.log(`   ⏳ Waiting ${delay}ms...`);
                    await wait(delay);
                }
            } catch (error) {
                console.error(`   ❌ Error: ${error.message}`);
                errors.push({ url: urls[i], error: error.message });
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

async function savePosts(result, username) {
    const postsDir = join(process.cwd(), 'posts');
    await mkdir(postsDir, { recursive: true });
    const outputPath = join(postsDir, `posts_${username}_${Date.now()}.json`);
    await writeFile(outputPath, JSON.stringify(result, null, 2));
    console.log(`\n💾 Saved: ${outputPath}`);
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
