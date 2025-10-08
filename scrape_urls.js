import puppeteer from 'puppeteer';
import { writeFile, mkdir, readFile, access } from 'fs/promises';
import { join } from 'path';
import { constants } from 'fs';
import 'dotenv/config';

const SESSION = process.env.SESSION;

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function randomDelay(min = 1000, max = 3000) {
    return sleep(min + Math.random() * (max - min));
}

async function scrollAndLoadPosts(page, selector, untilPostId, untilDate, verbose) {
    const collectedUrls = new Set();
    let previousCount = 0;
    let stableCount = 0;
    const maxScrollAttempts = 200;
    let scrollAttempts = 0;
    let foundTarget = false;

    while (scrollAttempts < maxScrollAttempts && !foundTarget) {
        const posts = await page.$$(selector);
        const currentCount = posts.length;

        for (let i = 0; i < posts.length; i++) {
            try {
                const href = await posts[i].evaluate(el => el.href);
                if (href && href.includes('/p/')) {
                    const shortcode = href.match(/\/p\/([^\/]+)\//)?.[1];
                    if (shortcode) {
                        const wasNew = !collectedUrls.has(shortcode);
                        collectedUrls.add(shortcode);
                        
                        if (untilPostId && shortcode === untilPostId) {
                            if (verbose) console.log(`   ✓ Found target post: ${untilPostId}`);
                            foundTarget = true;
                            break;
                        }
                    }
                }
            } catch (e) {}
        }

        if (foundTarget) break;

        if (currentCount === previousCount) {
            stableCount++;
            if (stableCount >= 5) {
                if (verbose) console.log(`   ℹ️  No more posts loading (reached end after ${scrollAttempts} scrolls)`);
                break;
            }
        } else {
            stableCount = 0;
        }

        if (verbose && scrollAttempts % 5 === 0) {
            console.log(`   📊 Collected ${collectedUrls.size} unique posts (${currentCount} visible in DOM)...`);
        }

        previousCount = currentCount;
        await page.evaluate(() => {
            window.scrollTo(0, document.body.scrollHeight);
        });
        await randomDelay(2000, 3000);
        scrollAttempts++;
    }

    if (verbose) {
        console.log(`   ✅ Finished scrolling. Collected ${collectedUrls.size} total unique posts`);
    }

    return Array.from(collectedUrls);
}

async function getPostUrls(username, maxUrls = 12, options = {}) {
    const {
        headless = true,
        slowMo = 100,
        verbose = true,
        untilPostId = null,
        untilDate = null
    } = options;

    console.log(`\n🔍 Getting post URLs from: @${username}`);
    console.log(`🎯 Target: Up to ${maxUrls} recent post URLs`);
    if (untilPostId) console.log(`🎯 Until post: ${untilPostId}`);
    if (untilDate) console.log(`🎯 Until date: ${untilDate}`);
    console.log(`🤖 Mode: ${headless ? 'Headless' : 'Visible'} Browser\n`);

    let browser;
    try {
        if (verbose) console.log('🚀 Launching browser...');
        browser = await puppeteer.launch({
            headless: headless ? 'new' : false,
            slowMo: slowMo,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-blink-features=AutomationControlled',
                '--disable-features=IsolateOrigins,site-per-process',
                '--window-size=1920,1080'
            ]
        });

        const page = await browser.newPage();

        await page.setViewport({
            width: 1920,
            height: 1080,
            deviceScaleFactor: 1,
        });

        await page.setUserAgent(
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        );

        await page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'webdriver', {
                get: () => false,
            });
        });

        await page.setExtraHTTPHeaders({
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        });

        if (SESSION) {
            if (verbose) console.log('🔐 Setting authentication cookies...');
            const cookies = SESSION.split(';').map(cookie => {
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
            
            await page.setCookie(...cookies);
            if (verbose) console.log('   ✓ Authentication cookies set');
        } else {
            if (verbose) console.log('⚠️  No SESSION found in .env - scraping without authentication');
        }

        const profileUrl = `https://www.instagram.com/${username}/`;
        if (verbose) console.log(`📡 Navigating to: ${profileUrl}`);
        
        await page.goto(profileUrl, {
            waitUntil: 'networkidle2',
            timeout: 30000
        });

        await randomDelay(2000, 4000);

        const isLoginWall = await page.evaluate(() => {
            return document.body.innerText.includes('Log in to continue') ||
                   document.body.innerText.includes('Sign up') ||
                   document.querySelector('[href="/accounts/login/"]') !== null;
        });

        if (isLoginWall) {
            console.log('⚠️  Instagram is showing a login wall');
            console.log('   Attempting to dismiss...');
            try {
                const closeButton = await page.$('button[aria-label="Close"]');
                if (closeButton) {
                    await closeButton.click();
                    await randomDelay(1000, 2000);
                    if (verbose) console.log('   ✓ Dismissed login dialog');
                }
            } catch (e) {}
        }

        await randomDelay(2000, 3000);

        if (verbose) console.log('⏳ Waiting for posts to appear...');
        
        const postSelectors = [
            'article a[href*="/p/"]',
            'a[href*="/p/"]',
            'div[role="button"] a[href*="/p/"]',
            '[class*="post"] a[href*="/p/"]'
        ];

        let workingSelector = null;
        for (const selector of postSelectors) {
            try {
                await page.waitForSelector(selector, { timeout: 10000 });
                const testPosts = await page.$$(selector);
                if (testPosts.length > 0) {
                    workingSelector = selector;
                    if (verbose) console.log(`   ✓ Found initial posts using selector: ${selector}`);
                    break;
                }
            } catch (e) {
                continue;
            }
        }

        if (!workingSelector) {
            console.log('⚠️  No posts found on the page');
            await browser.close();
            return {
                username,
                post_urls: [],
                total_found: 0,
                note: 'No posts found',
                scraped_at: new Date().toISOString()
            };
        }

        let collectedShortcodes = [];
        
        if (untilPostId || untilDate) {
            if (verbose) console.log('📜 Scrolling to load older posts and extracting URLs...');
            collectedShortcodes = await scrollAndLoadPosts(page, workingSelector, untilPostId, untilDate, verbose);
        } else {
            await page.evaluate(() => window.scrollBy(0, 300));
            await randomDelay(1500, 2000);
            
            const posts = await page.$$(workingSelector);
            if (verbose) console.log(`🔗 Extracting URLs from ${posts.length} post elements...`);
            
            const maxToExtract = Math.min(posts.length, maxUrls * 4);
            
            for (let i = 0; i < maxToExtract; i++) {
                try {
                    const href = await posts[i].evaluate(el => el.href);
                    if (href && href.includes('/p/')) {
                        const shortcode = href.match(/\/p\/([^\/]+)\//)?.[1];
                        if (shortcode) {
                            collectedShortcodes.push(shortcode);
                        }
                    }
                } catch (e) {}
            }
        }
        
        if (verbose && collectedShortcodes.length > 0) {
            console.log(`   📝 Total shortcodes extracted: ${collectedShortcodes.length}`);
            console.log(`   📝 Sample: ${collectedShortcodes.slice(0, 3).join(', ')}${collectedShortcodes.length > 3 ? '...' : ''}`);
        }

        const postUrls = new Set(collectedShortcodes.map(code => `https://www.instagram.com/p/${code}/`));
        const sortedUrls = Array.from(postUrls).sort((a, b) => {
            const codeA = a.match(/\/p\/([^\/]+)\//)?.[1] || '';
            const codeB = b.match(/\/p\/([^\/]+)\//)?.[1] || '';
            return codeB.localeCompare(codeA);
        });
        
        if (verbose && sortedUrls.length > 0) {
            console.log(`   📊 Total unique URLs found this scrape: ${sortedUrls.length}`);
            const newestCode = sortedUrls[0].match(/\/p\/([^\/]+)\//)?.[1];
            const oldestCode = sortedUrls[sortedUrls.length - 1].match(/\/p\/([^\/]+)\//)?.[1];
            console.log(`   📅 Range: ${newestCode} (newest) → ${oldestCode} (oldest)`);
        }

        let profileInfo = await extractProfileInfo(page, verbose);

        if (verbose) {
            console.log(`✅ Successfully extracted ${sortedUrls.length} post URLs`);
            if (sortedUrls.length > 0) {
                console.log(`   📋 Sample: ${sortedUrls.slice(0, 2).join(', ')}`);
            }
        }

        await browser.close();

        return {
            username,
            profile_info: profileInfo,
            post_urls: sortedUrls,
            total_found: sortedUrls.length,
            scraped_at: new Date().toISOString(),
            scraping_method: 'puppeteer'
        };

    } catch (error) {
        if (browser) {
            await browser.close();
        }
        throw new Error(`Scraping failed: ${error.message}`);
    }
}

async function extractDataFromPage(page, verbose) {
    if (verbose) console.log('🔍 Attempting to extract data from page source...');
    
    const pageData = await page.evaluate(() => {
        const username = window.location.pathname.split('/')[1];
        const postUrls = [];
        const scripts = document.querySelectorAll('script[type="application/json"]');
        
        for (const script of scripts) {
            try {
                const data = JSON.parse(script.textContent);
                if (data?.require) {
                    for (const req of data.require) {
                        if (req[3] && req[3][0]) {
                            const str = JSON.stringify(req[3][0]);
                            if (str.includes('edge_owner_to_timeline_media')) {
                                const matches = str.match(/instagram\.com\/p\/([^\/]+)\//g);
                                if (matches) {
                                    matches.forEach(match => {
                                        const shortcode = match.match(/\/p\/([^\/]+)\//)[1];
                                        postUrls.push(`https://www.instagram.com/p/${shortcode}/`);
                                    });
                                }
                            }
                        }
                    }
                }
            } catch (e) {}
        }
        
        return {
            username,
            post_urls: [...new Set(postUrls)],
            total_found: [...new Set(postUrls)].length
        };
    });
    
    if (verbose && pageData.post_urls.length > 0) {
        console.log(`   ✓ Extracted ${pageData.post_urls.length} URLs from page data`);
    }
    
    return pageData;
}

async function extractProfileInfo(page, verbose) {
    try {
        const info = await page.evaluate(() => {
            const getMetaContent = (property) => {
                const meta = document.querySelector(`meta[property="${property}"]`);
                return meta ? meta.getAttribute('content') : null;
            };

            const description = getMetaContent('og:description') || '';
            const title = getMetaContent('og:title') || document.title;
            const image = getMetaContent('og:image');
            const followersMatch = description.match(/([\d,\.]+[KMB]?)\s+Followers/i);
            const followingMatch = description.match(/([\d,\.]+[KMB]?)\s+Following/i);
            const postsMatch = description.match(/([\d,\.]+[KMB]?)\s+Posts/i);

            return {
                full_name: title.replace(' (@', '').replace(') • Instagram', '').trim(),
                profile_pic: image,
                followers: followersMatch ? followersMatch[1] : null,
                following: followingMatch ? followingMatch[1] : null,
                posts_count: postsMatch ? postsMatch[1] : null
            };
        });

        if (verbose && info.full_name) {
            console.log(`   ℹ️  Profile: ${info.full_name}`);
        }

        return info;
    } catch (e) {
        return {
            full_name: null,
            profile_pic: null
        };
    }
}

async function loadExistingUrls(filePath) {
    try {
        await access(filePath, constants.F_OK);
        const content = await readFile(filePath, 'utf-8');
        return JSON.parse(content);
    } catch (error) {
        return null;
    }
}

async function saveUrls(result, filename = null) {
    const urlsDir = join(process.cwd(), 'post-urls');
    await mkdir(urlsDir, { recursive: true });

    const outputFileName = filename || `urls_${result.username}.json`;
    const outputPath = join(urlsDir, outputFileName);
    
    const existing = await loadExistingUrls(outputPath);
    
    if (existing) {
        console.log(`\n📂 Found existing file with ${existing.post_urls.length} URLs`);
        
        const allUrls = new Set([...existing.post_urls, ...result.post_urls]);
        const mergedUrls = Array.from(allUrls);
        
        const newCount = mergedUrls.length - existing.post_urls.length;
        
        if (newCount > 0) {
            console.log(`   ➕ Adding ${newCount} new unique URL(s)`);
            console.log(`   📊 Total unique URLs: ${mergedUrls.length}`);
        } else {
            console.log(`   ℹ️  No new URLs found (all already existed)`);
        }
        
        result.post_urls = mergedUrls;
        result.total_found = mergedUrls.length;
        result.last_updated = new Date().toISOString();
        result.first_scraped = existing.scraped_at || existing.first_scraped;
    } else {
        console.log(`\n📝 Creating new file`);
        result.first_scraped = result.scraped_at;
        result.last_updated = result.scraped_at;
    }
    
    await writeFile(outputPath, JSON.stringify(result, null, 2));
    console.log(`💾 Saved: ${outputPath}`);
    return outputPath;
}

const args = process.argv.slice(2);
const username = args[0];
let count = args[1] ? parseInt(args[1]) : 12;
const headlessFlag = !args.includes('--visible');

let untilPostId = null;
let untilDate = null;

const untilIndex = args.indexOf('--until');
if (untilIndex !== -1 && args[untilIndex + 1]) {
    untilPostId = args[untilIndex + 1];
    count = 999999;
}

const dateIndex = args.indexOf('--until-date');
if (dateIndex !== -1 && args[dateIndex + 1]) {
    untilDate = args[dateIndex + 1];
    count = 999999;
}

if (!username) {
    console.error('❌ Usage: node scrape_urls.js <username> [count] [--visible] [--until POST_ID] [--until-date DATE]');
    console.error('   Example: node scrape_urls.js instagram 12');
    console.error('   Example: node scrape_urls.js instagram 12 --visible');
    console.error('   Example: node scrape_urls.js psv --until DMfBK5xMG_i');
    console.error('   Example: node scrape_urls.js psv --until-date 2025-07-24');
    console.error('');
    console.error('   Options:');
    console.error('     --visible         Show browser window (useful for debugging)');
    console.error('     --until POST_ID   Scrape until reaching specific post shortcode');
    console.error('     --until-date DATE Scrape until reaching specific date (YYYY-MM-DD)');
    process.exit(1);
}

console.log('╔═══════════════════════════════════════════════════════════╗');
console.log('║   Instagram Post URL Scraper - Puppeteer Edition         ║');
console.log('║   Browser automation for safer, human-like scraping       ║');
console.log('╚═══════════════════════════════════════════════════════════╝');

getPostUrls(username, count, { 
    headless: headlessFlag,
    slowMo: 50,
    verbose: true,
    untilPostId: untilPostId,
    untilDate: untilDate
})
    .then(async (result) => {
        console.log('\n' + '='.repeat(60));
        console.log('🔗 POST URLS SUMMARY');
        console.log('='.repeat(60));
        console.log(`Username: @${result.username}`);
        console.log(`Full Name: ${result.profile_info?.full_name || 'N/A'}`);
        console.log(`URLs Found: ${result.total_found}`);
        console.log(`Method: ${result.scraping_method || 'unknown'}`);

        if (result.total_found > 0) {
            console.log(`\n📋 Post URLs:`);
            result.post_urls.forEach((url, i) => {
                console.log(`${String(i + 1).padStart(2)}. ${url}`);
            });
        }

        await saveUrls(result);
        
        console.log('\n✅ Scraping completed successfully!');
    })
    .catch(error => {
        console.error(`\n❌ Error: ${error.message}`);
        console.error('\nTroubleshooting tips:');
        console.error('  • Try running with --visible to see what happens');
        console.error('  • Check if the username is correct');
        console.error('  • Instagram may be rate limiting - try again later');
        console.error('  • The account might be private');
        process.exit(1);
    });
