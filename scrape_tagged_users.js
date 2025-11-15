import puppeteer from 'puppeteer';
import { writeFile, mkdir, readFile } from 'fs/promises';
import { join } from 'path';
import mysql from 'mysql2/promise';
import * as dotenv from 'dotenv';

dotenv.config();

const DB_CONFIG = {
    host: 'localhost',
    port: 3306,
    user: 'remote',
    password: 'remote',
    database: 'psv_dev'
};

const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function scrapeTaggedUsers(page, postUrl) {
    console.log(`\n📸 Scraping tagged users: ${postUrl}`);
    
    const shortcode = postUrl.match(/\/p\/([^\/]+)\//)?.[1] || postUrl.match(/\/reel\/([^\/]+)\//)?.[1];
    
    await page.goto(postUrl, { waitUntil: 'domcontentloaded', timeout: 90000 });
    
    // Wait for JSON data to be embedded in page
    console.log('   ⏳ Waiting for data to load...');
    await wait(5000);
    
    // Extract post data from JSON embedded in page (same approach as scrape_posts.js)
    const {isCarousel, taggedUsers, carouselChildren, error} = await page.evaluate(() => {
        const scripts = Array.from(document.querySelectorAll('script[type="application/json"]'));
        let postInfo = null;
        
        // Find the script containing post data
        for (const script of scripts) {
            try {
                const data = JSON.parse(script.textContent);
                
                // Path to media data
                const media = data?.require?.[0]?.[3]?.[0]?.__bbox?.require?.[0]?.[3]?.[1]?.__bbox?.result?.data?.xdt_api__v1__media__shortcode__web_info?.items?.[0];
                
                if (media && media.code) {
                    postInfo = media;
                    break;
                }
            } catch (e) {}
        }
        
        if (!postInfo) {
            return { error: 'Could not find post JSON data', isCarousel: false, taggedUsers: [], carouselChildren: [] };
        }
        
        const isCarousel = postInfo.media_type === 8; // 8 = carousel/album
        const taggedUsers = [];
        
        // Function to extract tagged users from a single media item
        function extractTagsFromMedia(media) {
            const users = [];
            
            // Check usertags (photo tags)
            if (media.usertags && media.usertags.in) {
                media.usertags.in.forEach(tag => {
                    const username = tag.user?.username;
                    if (username) {
                        users.push(username);
                    }
                });
            }
            
            return users;
        }
        
        if (isCarousel && postInfo.carousel_media) {
            // For carousel, collect tags from all children
            const children = postInfo.carousel_media.map((child, idx) => ({
                slideNumber: idx + 1,
                taggedUsers: extractTagsFromMedia(child)
            }));
            
            return { isCarousel: true, taggedUsers: [], carouselChildren: children };
        } else {
            // For single image/video
            const users = extractTagsFromMedia(postInfo);
            return { isCarousel: false, taggedUsers: users, carouselChildren: [] };
        }
    });
    
    if (error) {
        console.log(`   ⚠ ${error}`);
        return { shortcode, taggedUsers: {} };
    }
    
    console.log(`   📦 Carousel: ${isCarousel ? 'Yes' : 'No'}`);
    
    const allTaggedUsers = new Map();
    
    if (isCarousel) {
        // Process carousel children
        carouselChildren.forEach(child => {
            console.log(`   📄 Slide ${child.slideNumber}`);
            console.log(`   👥 Found ${child.taggedUsers.length} tagged user(s): ${child.taggedUsers.join(', ') || 'none'}`);
            
            child.taggedUsers.forEach(username => {
                if (!allTaggedUsers.has(username)) {
                    allTaggedUsers.set(username, []);
                }
                allTaggedUsers.get(username).push(child.slideNumber);
            });
        });
    } else {
        // Process single post
        console.log(`   👥 Found ${taggedUsers.length} tagged user(s): ${taggedUsers.join(', ') || 'none'}`);
        
        taggedUsers.forEach(username => {
            allTaggedUsers.set(username, [1]);
        });
    }
    
    const result = {
        shortcode,
        url: postUrl,
        isCarousel,
        taggedUsers: Object.fromEntries(allTaggedUsers.entries())
    };
    
    console.log(`   ✅ Total unique tagged users: ${allTaggedUsers.size}`);
    
    return result;
}

async function scrapeMultiplePosts(postUrls, options = {}) {
    const { headless = true, delayBetweenPosts = 16000 } = options;
    
    console.log('\n╔═══════════════════════════════════════════════════════════╗');
    console.log('║   Instagram Tagged Users Scraper                         ║');
    console.log(`║   Scraping from ${String(postUrls.length).padStart(3)} posts${' '.repeat(33)}║`);
    console.log(`║   Estimated time: ${Math.round(postUrls.length * delayBetweenPosts / 1000 / 60)} minutes${' '.repeat(28)}║`);
    console.log('╚═══════════════════════════════════════════════════════════╝');
    
    const browser = await puppeteer.launch({
        headless,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-blink-features=AutomationControlled',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--disable-gpu',
            '--window-size=1920,1080'
        ]
    });
    
    const page = await browser.newPage();
    
    // Rotate user agents
    const userAgents = [
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15'
    ];
    const randomUserAgent = userAgents[Math.floor(Math.random() * userAgents.length)];
    await page.setUserAgent(randomUserAgent);
    
    // Set viewport
    await page.setViewport({ width: 1920, height: 1080 });
    
    // Set headers
    await page.setExtraHTTPHeaders({
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'keep-alive',
        'DNT': '1',
        'Upgrade-Insecure-Requests': '1',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1'
    });
    
    // Hide automation indicators
    await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'webdriver', {
            get: () => false
        });
        Object.defineProperty(navigator, 'plugins', {
            get: () => [1, 2, 3, 4, 5]
        });
        Object.defineProperty(navigator, 'languages', {
            get: () => ['en-US', 'en']
        });
        window.chrome = { runtime: {} };
    });
    
    // Set cookies for authentication
    const sessionId = process.env.SESSION;
    if (sessionId) {
        console.log('🔐 Setting authentication cookies...');
        
        const cookies = sessionId.split(';').map(cookie => {
            const [fullCookie] = cookie.trim().split(';');
            const [name, ...valueParts] = fullCookie.split('=');
            return {
                name: name.trim(),
                value: valueParts.join('=').trim(),
                domain: '.instagram.com',
                path: '/',
                httpOnly: true,
                secure: true
            };
        });
        
        // Navigate to Instagram first
        await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded' });
        await page.setCookie(...cookies);
        console.log('   ✓ Authentication cookies set\n');
    }
    
    const results = [];
    
    for (let i = 0; i < postUrls.length; i++) {
        console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log(`📍 Post ${i + 1} of ${postUrls.length}`);
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        
        const result = await scrapeTaggedUsers(page, postUrls[i]);
        results.push(result);
        
        // Save individual result
        await saveTaggedUsers(result);
        
        // Delay between posts to avoid rate limiting
        if (i < postUrls.length - 1) {
            const variance = delayBetweenPosts * 0.2;
            const delay = Math.floor(delayBetweenPosts - variance + Math.random() * variance * 2);
            console.log(`⏳ Waiting ${(delay / 1000).toFixed(1)}s before next post...`);
            await wait(delay);
        }
    }
    
    console.log('\n🔒 Closing browser...\n');
    await browser.close();
    
    return results;
}

async function saveTaggedUsers(result) {
    const outputDir = join(process.cwd(), 'tagged-users');
    await mkdir(outputDir, { recursive: true });
    
    const filename = join(outputDir, `tags_${result.shortcode}.json`);
    await writeFile(filename, JSON.stringify(result, null, 2));
    console.log(`💾 Saved: ${filename}`);
}

async function getPostUrlsFromDatabase(startIndex = 0) {
    console.log('📊 Connecting to database...');
    const connection = await mysql.createConnection(DB_CONFIG);
    
    try {
        const [rows] = await connection.execute(
            'SELECT url FROM instagram_posts WHERE url IS NOT NULL ORDER BY id'
        );
        
        const allUrls = rows.map(row => row.url);
        
        if (startIndex > 0) {
            console.log(`✓ Found ${allUrls.length} posts in database`);
            console.log(`⏩ Resuming from index ${startIndex} (skipping ${startIndex} posts)\n`);
            return allUrls.slice(startIndex);
        }
        
        console.log(`✓ Found ${allUrls.length} posts in database\n`);
        return allUrls;
    } finally {
        await connection.end();
    }
}

// Main execution
async function main() {
    const args = process.argv.slice(2);
    const useDatabase = args.includes('--database') || args.includes('--db');
    const resumeIndex = args.find(arg => arg.startsWith('--resume='))?.split('=')[1];
    
    let postUrls;
    let delayBetweenPosts = 16000; // Default: ~16 seconds between posts
    let startIndex = 0;
    
    if (useDatabase) {
        if (resumeIndex) {
            startIndex = parseInt(resumeIndex, 10);
            if (isNaN(startIndex) || startIndex < 0) {
                console.error('Invalid resume index. Must be a positive number.');
                process.exit(1);
            }
        }
        
        // Get URLs from database
        postUrls = await getPostUrlsFromDatabase(startIndex);
        
        // Increase delay for database mode
        delayBetweenPosts = 20000;
    } else {
        // Get URLs from JSON file
        const inputFile = args[0];
        
        if (!inputFile) {
            console.error('Usage: node scrape_tagged_users.js <urls-file.json>');
            console.error('   or: node scrape_tagged_users.js --database [--resume=INDEX]');
            process.exit(1);
        }
        
        const urlsContent = await readFile(inputFile, 'utf-8');
        const urlsData = JSON.parse(urlsContent);
        postUrls = urlsData.post_urls || urlsData.urls || (Array.isArray(urlsData) ? urlsData : []);
    }
    
    const results = await scrapeMultiplePosts(postUrls, { delayBetweenPosts });
    
    console.log('\n╔═══════════════════════════════════════════════════════════╗');
    console.log('║   SCRAPING COMPLETE                                       ║');
    console.log(`║   Total posts processed: ${results.length}${' '.repeat(31)}║`);
    console.log(`║   Posts with tags: ${results.filter(r => Object.keys(r.taggedUsers).length > 0).length}${' '.repeat(37)}║`);
    console.log('╚═══════════════════════════════════════════════════════════╝\n');
}

main().catch(console.error);
