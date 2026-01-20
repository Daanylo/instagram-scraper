import puppeteer from 'puppeteer';
import { writeFile, mkdir, readFile, access, rename } from 'fs/promises';
import { join } from 'path';
import { constants } from 'fs';

const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function getHumanDelay(baseDelay = 40000) {
    const variance = 0.5;
    const minDelay = baseDelay * (1 - variance);
    const maxDelay = baseDelay * (1 + variance);
    return Math.floor(minDelay + Math.random() * (maxDelay - minDelay));
}

function shouldTakeBreak(postIndex) {
    const breakInterval = 15 + Math.floor(Math.random() * 10);
    return postIndex > 0 && postIndex % breakInterval === 0;
}

function getBreakDuration() {
    return (3 + Math.random() * 2) * 60 * 1000;
}

async function scrapePost(page, postUrl, retryCount = 0) {
    console.log(`\n📸 Scraping: ${postUrl}`);
    
    const response = await page.goto(postUrl, { waitUntil: 'domcontentloaded', timeout: 90000 });
    
    if (response.status() === 429) {
        throw new Error('RATE_LIMITED');
    }
    
    const loadWait = 3000 + Math.floor(Math.random() * 4000);
    await wait(loadWait);
    
    const isRateLimited = await page.evaluate(() => {
        const bodyText = document.body.innerText;
        return bodyText.includes('Please wait a few minutes') || 
               bodyText.includes('Try again later') ||
               bodyText.includes('too many requests');
    });
    
    if (isRateLimited) {
        throw new Error('RATE_LIMITED');
    };
    
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
            
            // Extract tagged users from media
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
            
            // Build tagged users object
            const taggedUsers = {};
            
            if (isCarousel && postInfo.carousel_media) {
                // For carousel, collect tags from all children
                postInfo.carousel_media.forEach((child, idx) => {
                    const users = extractTagsFromMedia(child);
                    users.forEach(username => {
                        if (!taggedUsers[username]) {
                            taggedUsers[username] = [];
                        }
                        taggedUsers[username].push(idx + 1);
                    });
                });
            } else {
                // For single image/video
                const users = extractTagsFromMedia(postInfo);
                users.forEach(username => {
                    taggedUsers[username] = [1];
                });
            }
            
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
                tagged_users: Object.keys(taggedUsers).length > 0 ? taggedUsers : null,
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
    const taggedCount = postData.tagged_users ? Object.keys(postData.tagged_users).length : 0;
    const taggedInfo = taggedCount > 0 ? ` | 👥 ${taggedCount}` : '';
    console.log(`   ✅ ${postData.post_type?.toUpperCase() || 'POST'} | ❤️  ${likes} | 💬 ${comments}${taggedInfo}`);
    return postData;
}

function parseShortcodeFromUrl(postUrl) {
    try {
        const url = new URL(postUrl);
        const parts = url.pathname.split('/').filter(Boolean);
        const pIndex = parts.indexOf('p');
        if (pIndex >= 0 && parts[pIndex + 1]) return parts[pIndex + 1];
        const reelIndex = parts.indexOf('reel');
        if (reelIndex >= 0 && parts[reelIndex + 1]) return parts[reelIndex + 1];
        return null;
    } catch {
        const parts = String(postUrl).split('/').filter(Boolean);
        const pIndex = parts.indexOf('p');
        if (pIndex >= 0 && parts[pIndex + 1]) return parts[pIndex + 1];
        const reelIndex = parts.indexOf('reel');
        if (reelIndex >= 0 && parts[reelIndex + 1]) return parts[reelIndex + 1];
        return null;
    }
}

function isRecoverablePageError(errorMessage) {
    const msg = String(errorMessage || '').toLowerCase();
    return (
        msg.includes('detached frame') ||
        msg.includes('execution context was destroyed') ||
        msg.includes('target closed') ||
        msg.includes('session closed') ||
        msg.includes('most likely because of a navigation')
    );
}

async function writeJsonAtomic(filePath, data) {
    const tmpPath = `${filePath}.tmp`;
    await writeFile(tmpPath, JSON.stringify(data, null, 2));
    await rename(tmpPath, filePath);
}

async function createConfiguredPage(browser) {
    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });

    await page.setExtraHTTPHeaders({
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'DNT': '1',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1',
        'Cache-Control': 'max-age=0'
    });

    await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => false });
        Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
        Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
        window.chrome = { runtime: {} };
    });

    return page;
}

async function scrapePosts(urls, options = {}) {
    const { delay = 40000, headless = true, username = null, checkpointEvery = 1 } = options;
    
    const userAgents = [
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:121.0) Gecko/20100101 Firefox/121.0'
    ];
    
    // Remove duplicate URLs before scraping
    const uniqueUrls = [...new Set(urls)];
    if (uniqueUrls.length < urls.length) {
        console.log(`ℹ️  Removed ${urls.length - uniqueUrls.length} duplicate URL(s)`);
    }
    
    const postsDir = join(process.cwd(), 'posts');
    await mkdir(postsDir, { recursive: true });
    const outputPath = username ? join(postsDir, `posts_${username}.json`) : null;

    const existing = outputPath ? await loadExistingPosts(outputPath) : null;
    const postsByShortcode = new Map();
    const existingShortcodes = new Set();
    const existingErrors = [];

    if (existing?.posts?.length) {
        for (const post of existing.posts) {
            if (post?.shortcode) {
                postsByShortcode.set(post.shortcode, post);
                existingShortcodes.add(post.shortcode);
            }
        }
    }
    if (Array.isArray(existing?.errors)) {
        existingErrors.push(...existing.errors);
    }

    const remainingUrls = username
        ? uniqueUrls.filter((u) => {
            const sc = parseShortcodeFromUrl(u);
            return !sc || !existingShortcodes.has(sc);
        })
        : uniqueUrls;

    if (username && existingShortcodes.size > 0) {
        console.log(`\n↻ Resume enabled: ${existingShortcodes.size} post(s) already saved`);
        console.log(`⟏ Scraping ${remainingUrls.length} remaining post(s) (from ${uniqueUrls.length} unique URLs)...`);
    } else {
        console.log(`\n⟏ Scraping ${remainingUrls.length} unique posts...`);
    }
    console.log('🚀 Launching browser...');
    
    const browser = await puppeteer.launch({
        headless: headless,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    let page = await createConfiguredPage(browser);
    const errors = [...existingErrors];

    const startedAt = existing?.first_scraped || existing?.scraped_at || new Date().toISOString();
    const result = {
        posts: [],
        total_scraped: 0,
        total_errors: 0,
        errors: [],
        scraped_at: startedAt,
        first_scraped: existing?.first_scraped || existing?.scraped_at || startedAt,
        last_updated: new Date().toISOString()
    };

    async function checkpointSave(force = false) {
        if (!outputPath) return;
        if (!force && checkpointEvery > 1) {
            const count = postsByShortcode.size;
            if (count % checkpointEvery !== 0) return;
        }

        result.posts = Array.from(postsByShortcode.values());
        result.total_scraped = result.posts.length;
        result.errors = errors;
        result.total_errors = errors.length;
        result.last_updated = new Date().toISOString();
        await writeJsonAtomic(outputPath, result);
    }
    
    try {
        for (let i = 0; i < remainingUrls.length; i++) {
            try {
                const randomUA = userAgents[Math.floor(Math.random() * userAgents.length)];
                await page.setUserAgent(randomUA);

                const currentUrl = remainingUrls[i];
                let postData = null;

                for (let attempt = 0; attempt < 2; attempt++) {
                    try {
                        postData = await scrapePost(page, currentUrl);
                        break;
                    } catch (e) {
                        if (e?.message === 'RATE_LIMITED') throw e;

                        if (attempt === 0 && isRecoverablePageError(e?.message)) {
                            console.log('   🔄 Page context lost; recreating tab and retrying...');
                            try {
                                await page.close({ runBeforeUnload: false });
                            } catch {}
                            page = await createConfiguredPage(browser);
                            await page.setUserAgent(randomUA);
                            continue;
                        }
                        throw e;
                    }
                }

                if (!postData) {
                    throw new Error('UNKNOWN_SCRAPE_FAILURE');
                }

                if (postData.shortcode && postsByShortcode.has(postData.shortcode)) {
                    console.log(`   ⚠️  Skipping duplicate post: ${postData.shortcode}`);
                } else if (postData.shortcode) {
                    postsByShortcode.set(postData.shortcode, postData);
                }

                await checkpointSave(false);
                
                if (shouldTakeBreak(i + 1)) {
                    const breakDuration = getBreakDuration();
                    console.log(`\n☕ Taking a break (${(breakDuration / 60000).toFixed(1)} minutes) after ${i + 1} posts...`);
                    await wait(breakDuration);
                }

                if (i < remainingUrls.length - 1) {
                    const humanDelay = getHumanDelay(delay);
                    console.log(`   ⏳ Waiting ${(humanDelay / 1000).toFixed(1)}s...`);
                    await wait(humanDelay);
                }
            } catch (error) {
                if (error.message === 'RATE_LIMITED') {
                    console.error(`\n⚠️  Rate limited! Implementing exponential backoff...`);
                    const waitTimes = [2, 5, 10];
                    const retries = Math.min(errors.filter(e => e.error === 'RATE_LIMITED').length, waitTimes.length - 1);
                    const waitMinutes = waitTimes[retries];
                    console.log(`   ⏳ Waiting ${waitMinutes} minutes before retry...`);
                    await wait(waitMinutes * 60 * 1000);
                    i--;
                } else {
                    console.error(`   ❌ Error: ${error.message}`);
                    errors.push({ url: remainingUrls[i], error: error.message });
                    await checkpointSave(true);

                    if (isRecoverablePageError(error.message)) {
                        try {
                            await page.close({ runBeforeUnload: false });
                        } catch {}
                        page = await createConfiguredPage(browser);
                    }
                }
            }
        }
    } finally {
        await checkpointSave(true);
        console.log('\n🔒 Closing browser...');
        await browser.close();
    }

    result.posts = Array.from(postsByShortcode.values());
    result.total_scraped = result.posts.length;
    result.total_errors = errors.length;
    result.errors = errors;
    result.last_updated = new Date().toISOString();
    return result;
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
    const outputPath = join(postsDir, `posts_${username}.json`);
    await writeJsonAtomic(outputPath, result);
    console.log(`💾 Saved: ${outputPath}`);
}

const args = process.argv.slice(2);
if (args.length === 0) {
    console.error('Usage: node scrape_posts.js <url_file.json> [delay_ms] [--show-browser]');
    process.exit(1);
}

const inputFile = args[0];
const delay = args[1] && !args[1].startsWith('--') ? parseInt(args[1]) : 40000;
const showBrowser = args.includes('--show-browser');

(async () => {
    try {
        const { urls, username } = await loadUrlsFromFile(inputFile);
        const result = await scrapePosts(urls, { delay, headless: !showBrowser, username, checkpointEvery: 1 });
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
