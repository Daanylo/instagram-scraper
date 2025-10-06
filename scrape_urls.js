import fetch from 'node-fetch';
import { writeFile, mkdir } from 'fs/promises';
import { join } from 'path';

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

    // Extract post URLs from edges
    const urls = posts.edges
        .slice(0, maxUrls)
        .map(edge => {
            const shortcode = edge.node.shortcode;
            return `https://www.instagram.com/p/${shortcode}/`;
        });
    
    console.log(`✅ Found ${urls.length} post URLs`);
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

async function saveUrls(result, filename = null) {
    const urlsDir = join(process.cwd(), 'post-urls');
    await mkdir(urlsDir, { recursive: true });

    const outputFileName = filename || `urls_${result.username}_${Date.now()}.json`;
    const outputPath = join(urlsDir, outputFileName);
    
    await writeFile(outputPath, JSON.stringify(result, null, 2));
    console.log(`\n💾 Saved: ${outputPath}`);
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
