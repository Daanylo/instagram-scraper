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

async function getPostUrls(username, maxUrls = 12, options = {}) {
    const {
        headless = true,
        slowMo = 100,
        verbose = true
    } = options;

    console.log(`\n🔍 Getting post URLs from: @${username}`);
    console.log(`🎯 Target: Up to ${maxUrls} recent post URLs`);
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
        await page.evaluate(() => window.scrollBy(0, 300));
        await randomDelay(1500, 2000);

        if (verbose) console.log('⏳ Waiting for posts to appear...');
        
        const postSelectors = [
            'article a[href*="/p/"]',
            'a[href*="/p/"]',
            'div[role="button"] a[href*="/p/"]',
            '[class*="post"] a[href*="/p/"]'
        ];

        let posts = [];
        let workingSelector = null;
        for (const selector of postSelectors) {
            try {
                await page.waitForSelector(selector, { timeout: 10000 });
                posts = await page.$$(selector);
                if (posts.length > 0) {
                    workingSelector = selector;
                    if (verbose) console.log(`   ✓ Found ${posts.length} post elements using selector: ${selector}`);
                    break;
                }
            } catch (e) {
                continue;
            }
        }

        const pageDataUrls = await extractDataFromPage(page, verbose);
        
        if (posts.length === 0 && pageDataUrls.post_urls.length === 0) {
            console.log('⚠️  No posts found on the page');
            console.log('   This could mean:');
            console.log('   - The account is private');
            console.log('   - Instagram changed their HTML structure');
            console.log('   - The account has no posts');
            console.log('   - Instagram detected automation');
            
            await browser.close();
            
            return {
                username,
                post_urls: [],
                total_found: 0,
                note: 'No posts found - account may be private or page structure changed',
                scraped_at: new Date().toISOString()
            };
        }
        
        if (posts.length === 0 && pageDataUrls.post_urls.length > 0) {
            if (verbose) console.log(`   ✓ Using ${pageDataUrls.post_urls.length} posts from page JSON data`);
            posts = [];
        }

        if (workingSelector) {
            posts = await page.$$(workingSelector);
            if (verbose && posts.length > 0) {
                console.log(`   🔄 Re-queried: Found ${posts.length} total post elements after scrolling`);
            }
        }
        
        if (verbose) console.log(`🔗 Extracting URLs from ${posts.length} post elements...`);
        
        const postUrls = new Set();
        const allFoundUrls = [];
        
        for (let i = 0; i < Math.min(posts.length, maxUrls * 4); i++) {
            try {
                const href = await posts[i].evaluate(el => el.href);
                if (href && href.includes('/p/')) {
                    const cleanUrl = href.endsWith('/') ? href : href + '/';
                    const shortcode = cleanUrl.match(/\/p\/([^\/]+)\//)?.[1];
                    allFoundUrls.push(shortcode);
                    postUrls.add(cleanUrl);
                }
            } catch (e) {}
        }
        
        if (verbose && allFoundUrls.length > 0) {
            console.log(`   📝 Found shortcodes: ${allFoundUrls.slice(0, 5).join(', ')}${allFoundUrls.length > 5 ? '...' : ''}`);
        }

        pageDataUrls.post_urls.forEach(url => postUrls.add(url));
        
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
const count = args[1] ? parseInt(args[1]) : 12;
const headlessFlag = !args.includes('--visible');

if (!username) {
    console.error('❌ Usage: node scrape_urls_puppeteer.js <username> [count] [--visible]');
    console.error('   Example: node scrape_urls_puppeteer.js instagram 12');
    console.error('   Example: node scrape_urls_puppeteer.js instagram 12 --visible');
    console.error('');
    console.error('   Options:');
    console.error('     --visible    Show browser window (useful for debugging)');
    process.exit(1);
}

console.log('╔═══════════════════════════════════════════════════════════╗');
console.log('║   Instagram Post URL Scraper - Puppeteer Edition         ║');
console.log('║   Browser automation for safer, human-like scraping       ║');
console.log('╚═══════════════════════════════════════════════════════════╝');

getPostUrls(username, count, { 
    headless: headlessFlag,
    slowMo: 50,
    verbose: true 
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
