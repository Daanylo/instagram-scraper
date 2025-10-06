import fetch from 'node-fetch';
import { writeFile, mkdir, readFile, access } from 'fs/promises';
import { join } from 'path';
import { constants } from 'fs';

// ============================================================================
// Instagram Post URL Scraper - No Login Required!
// Based on: https://scrapfly.io/blog/posts/how-to-scrape-instagram
// ============================================================================

async function getPostUrls(username, maxUrls = 12) {
    console.log(`\n🔍 Getting post URLs from: @${username}`);
    console.log(`🎯 Target: Up to ${maxUrls} recent post URLs\n`);

    // Use the i.instagram.com API endpoint (works without login!)
    const apiUrl = `https://i.instagram.com/api/v1/users/web_profile_info/?username=${username}`;
    
    console.log(`📡 Calling Instagram API...`);
    
    const response = await fetch(apiUrl, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'X-IG-App-ID': '936619743392459',
            'Accept': '*/*',
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept-Encoding': 'gzip, deflate, br'
        }
    });

    if (!response.ok) {
        throw new Error(`Instagram API returned status ${response.status}`);
    }

    const data = await response.json();
    const user = data?.data?.user;
    const posts = user?.edge_owner_to_timeline_media;
    
    if (!posts || !posts.edges || posts.edges.length === 0) {
        console.log(`⚠️  No posts found for @${username}`);
        return {
            username,
            post_urls: [],
            total_found: 0,
            note: user?.is_private ? 'Account is private' : 'No posts found',
            scraped_at: new Date().toISOString()
        };
    }

    // Extract post URLs from edges and ensure uniqueness
    const urlSet = new Set();
    posts.edges
        .slice(0, maxUrls)
        .forEach(edge => {
            const shortcode = edge.node.shortcode;
            const url = `https://www.instagram.com/p/${shortcode}/`;
            urlSet.add(url);
        });
    
    const urls = Array.from(urlSet);
    
    console.log(`✅ Found ${urls.length} unique post URLs`);
    console.log(`   📋 Sample: ${urls.slice(0, 3).join(', ')}`);
    
    const ownerInfo = user;
    
    return {
        username,
        profile_info: {
            full_name: ownerInfo?.full_name || username,
            is_private: ownerInfo?.is_private || false,
            is_verified: ownerInfo?.is_verified || false,
            profile_pic: ownerInfo?.profile_pic_url
        },
        post_urls: urls,
        total_found: urls.length,
        has_next_page: posts.page_info?.has_next_page || false,
        scraped_at: new Date().toISOString()
    };
}

async function loadExistingUrls(filePath) {
    try {
        await access(filePath, constants.F_OK);
        const content = await readFile(filePath, 'utf-8');
        return JSON.parse(content);
    } catch (error) {
        return null; // File doesn't exist
    }
}

async function saveUrls(result, filename = null) {
    const urlsDir = join(process.cwd(), 'post-urls');
    await mkdir(urlsDir, { recursive: true });

    // Use consistent filename without timestamp
    const outputFileName = filename || `urls_${result.username}.json`;
    const outputPath = join(urlsDir, outputFileName);
    
    // Load existing data if file exists
    const existing = await loadExistingUrls(outputPath);
    
    if (existing) {
        console.log(`\n📂 Found existing file with ${existing.post_urls.length} URLs`);
        
        // Merge URLs and deduplicate
        const allUrls = new Set([...existing.post_urls, ...result.post_urls]);
        const mergedUrls = Array.from(allUrls);
        
        const newCount = mergedUrls.length - existing.post_urls.length;
        
        if (newCount > 0) {
            console.log(`   ➕ Adding ${newCount} new unique URL(s)`);
            console.log(`   📊 Total unique URLs: ${mergedUrls.length}`);
        } else {
            console.log(`   ℹ️  No new URLs found (all already existed)`);
        }
        
        // Update result with merged data
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

// ============================================================================
// Main
// ============================================================================

const args = process.argv.slice(2);
const username = args[0];
const count = args[1] ? parseInt(args[1]) : 12;

if (!username) {
    console.error('❌ Usage: node get_post_urls_v2.js <username> [count]');
    console.error('   Example: node get_post_urls_v2.js instagram 12');
    process.exit(1);
}

getPostUrls(username, count)
    .then(async (result) => {
        console.log('\n' + '='.repeat(60));
        console.log('🔗 POST URLS SUMMARY');
        console.log('='.repeat(60));
        console.log(`Username: @${result.username}`);
        console.log(`Full Name: ${result.profile_info?.full_name || 'N/A'}`);
        console.log(`URLs Found: ${result.total_found}`);
        console.log(`Has More: ${result.has_next_page ? 'Yes' : 'No'}`);

        if (result.total_found > 0) {
            console.log(`\n📋 Post URLs:`);
            result.post_urls.forEach((url, i) => {
                console.log(`${String(i + 1).padStart(2)}. ${url}`);
            });
        }

        await saveUrls(result);
    })
    .catch(error => {
        console.error(`\n❌ Error: ${error.message}`);
        process.exit(1);
    });
