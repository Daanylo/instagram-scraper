import fetch from 'node-fetch';
import { writeFile, mkdir } from 'fs/promises';
import { join, isAbsolute, basename } from 'path';
import 'dotenv/config';

// ============================================================================
// Configuration
// ============================================================================

const SESSION = process.env.SESSION;

if (!SESSION) {
    throw new Error('SESSION environment variable is required in .env file');
}

// ============================================================================
// Utilities
// ============================================================================

function extractUsername(profileUrl) {
    const match = profileUrl.match(/instagram\.com\/([^\/\?]+)/);
    if (!match) throw new Error('Invalid Instagram profile URL');
    return match[1];
}

function parsePost(edge) {
    const node = edge.node;
    return {
        id: node.id,
        shortcode: node.shortcode,
        url: `https://www.instagram.com/p/${node.shortcode}/`,
        display_url: node.display_url,
        caption: node.edge_media_to_caption?.edges?.[0]?.node?.text || '',
        likes: node.edge_liked_by?.count || 0,
        comments: node.edge_media_to_comment?.count || 0,
        timestamp: node.taken_at_timestamp,
        date: new Date(node.taken_at_timestamp * 1000).toISOString(),
        is_video: node.is_video,
        video_view_count: node.video_view_count || null,
        dimensions: {
            height: node.dimensions?.height,
            width: node.dimensions?.width
        },
        typename: node.__typename
    };
}

function parseProfile(userData) {
    const user = userData.user;
    return {
        id: user.id,
        username: user.username,
        full_name: user.full_name,
        biography: user.biography,
        external_url: user.external_url,
        followers_count: user.edge_followed_by?.count || 0,
        following_count: user.edge_follow?.count || 0,
        posts_count: user.edge_owner_to_timeline_media?.count || 0,
        is_private: user.is_private,
        is_verified: user.is_verified,
        is_business_account: user.is_business_account,
        is_professional_account: user.is_professional_account,
        profile_pic_url: user.profile_pic_url,
        profile_pic_url_hd: user.profile_pic_url_hd,
        category_name: user.category_name,
        business_category_name: user.business_category_name
    };
}

// ============================================================================
// API Functions
// ============================================================================

async function fetchProfileInfo(username) {
    // Use GraphQL directly to fetch user info
    const url = `https://www.instagram.com/api/v1/users/web_profile_info/?username=${username}`;
    
    const response = await fetch(url, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36',
            'X-IG-App-ID': '936619743392459',
            'X-CSRFToken': 'missing',
            'X-Requested-With': 'XMLHttpRequest',
            'Cookie': SESSION,
            'Accept': '*/*',
            'Accept-Language': 'en-US,en;q=0.9',
            'Referer': `https://www.instagram.com/${username}/`,
            'Origin': 'https://www.instagram.com',
            'Sec-Fetch-Dest': 'empty',
            'Sec-Fetch-Mode': 'cors',
            'Sec-Fetch-Site': 'same-origin'
        }
    });

    if (!response.ok) {
        return await fetchProfileInfoFallback(username);
    }

    const data = await response.json();
    
    if (!data.data?.user) {
        throw new Error('Invalid response structure or user not found');
    }

    return parseProfile({ user: data.data.user });
}

async function fetchProfileInfoFallback(username) {
    console.log(`   ⚠️  API failed, trying fallback method...`);
    
    const profileUrl = `https://www.instagram.com/${username}/`;
    
    const response = await fetch(profileUrl, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36',
            'Cookie': SESSION,
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
            'Cache-Control': 'no-cache',
            'Upgrade-Insecure-Requests': '1'
        }
    });

    if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const html = await response.text();
    
    const titleMatch = html.match(/<title[^>]*>([^<]+)/);
    const descMatch = html.match(/<meta\s+(?:property="og:description"|name="description")\s+content="([^"]+)"/i);
    const imageMatch = html.match(/<meta\s+property="og:image"\s+content="([^"]+)"/i);
    
    const followerMatch = html.match(/(\d+(?:,\d+)*(?:\.\d+)?[KMB]?)\s+followers?/i);
    const followingMatch = html.match(/(\d+(?:,\d+)*(?:\.\d+)?[KMB]?)\s+following/i);
    const postsMatch = html.match(/(\d+(?:,\d+)*(?:\.\d+)?[KMB]?)\s+posts?/i);
    
    function parseCount(countStr) {
        if (!countStr) return 0;
        const multipliers = { 'K': 1000, 'M': 1000000, 'B': 1000000000 };
        const match = countStr.match(/([\d,]+(?:\.\d+)?)([KMB]?)/i);
        if (!match) return 0;
        const num = parseFloat(match[1].replace(/,/g, ''));
        const mult = multipliers[match[2]?.toUpperCase()] || 1;
        return Math.round(num * mult);
    }

    return {
        id: null,
        username: username,
        full_name: titleMatch ? titleMatch[1].split('(@')[0].trim() : username,
        biography: descMatch ? descMatch[1] : '',
        external_url: '',
        followers_count: parseCount(followerMatch?.[1]),
        following_count: parseCount(followingMatch?.[1]),
        posts_count: parseCount(postsMatch?.[1]),
        is_private: html.includes('This Account is Private') || html.includes('private account'),
        is_verified: html.includes('verified') || html.includes('Verified'),
        is_business_account: html.includes('business') || html.includes('Business'),
        is_professional_account: false,
        profile_pic_url: imageMatch ? imageMatch[1] : '',
        profile_pic_url_hd: imageMatch ? imageMatch[1] : '',
        category_name: null,
        business_category_name: null
    };
}

async function fetchPostsPage(username, _endCursor = '', _first = 24) {
    const url = `https://www.instagram.com/api/v1/users/web_profile_info/?username=${username}`;
    
    const response = await fetch(url, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36',
            'X-IG-App-ID': '936619743392459',
            'X-CSRFToken': 'missing', 
            'X-Requested-With': 'XMLHttpRequest',
            'Cookie': SESSION,
            'Accept': '*/*',
            'Accept-Language': 'en-US,en;q=0.9',
            'Referer': `https://www.instagram.com/${username}/`,
            'Origin': 'https://www.instagram.com',
            'Sec-Fetch-Dest': 'empty',
            'Sec-Fetch-Mode': 'cors',
            'Sec-Fetch-Site': 'same-origin'
        }
    });

    if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const data = await response.json();
    
    const postsData = data.data?.user?.edge_owner_to_timeline_media;
    
    if (!postsData) {
        const altPosts = data.data?.user?.media?.edges || 
                        data.data?.user?.timeline?.edges ||
                        data.data?.user?.posts?.edges ||
                        [];
        
        if (altPosts.length > 0) {
            return {
                posts: altPosts,
                hasNextPage: false,
                endCursor: '',
                count: altPosts.length
            };
        }
        
        throw new Error('No posts data found in any expected location');
    }

    return {
        posts: postsData.edges || [],
        hasNextPage: postsData.page_info?.has_next_page || false,
        endCursor: postsData.page_info?.end_cursor || '',
        count: postsData.count || 0
    };
}

async function scrapeProfile(profileUrl, maxPosts = 100, pageSize = 24) {
    const username = extractUsername(profileUrl);
    console.log(`\n🔍 Scraping profile: ${profileUrl}`);
    console.log(`👤 Username: ${username}`);

    try {
        console.log(`\n📄 Fetching profile information...`);
        const profileInfo = await fetchProfileInfo(username);
        
        console.log(`✅ Profile loaded: @${profileInfo.username}`);
        if (profileInfo.followers_count) {
            console.log(`📊 Followers: ${profileInfo.followers_count.toLocaleString()}`);
            console.log(`📊 Following: ${profileInfo.following_count.toLocaleString()}`);
            console.log(`📊 Posts: ${profileInfo.posts_count.toLocaleString()}`);
        } else {
            console.log(`📊 Basic profile info extracted (detailed stats require GraphQL)`);
        }

        if (profileInfo.is_private) {
            console.log(`🔒 Account is private - posts may not be accessible`);
        }

        const allPosts = [];
        let pageCount = 0;

        if (!profileInfo.is_private && maxPosts > 0) {
            console.log(`\n📸 Fetching posts (max: ${maxPosts})...`);
            
            try {
                pageCount++;
                console.log(`\n📄 Fetching recent posts...`);
                
                const result = await fetchPostsPage(username, '', pageSize);
                const parsed = result.posts.map(parsePost);
                allPosts.push(...parsed);
                
                if (parsed.length > 0) {
                    console.log(`   ✅ Fetched ${parsed.length} posts`);
                } else {
                    console.log(`   ⚠️  No posts data available (Instagram API limitation for this account)`);
                    console.log(`   📊 Profile shows ${profileInfo.posts_count.toLocaleString()} total posts exist`);
                }
                                
            } catch (postsError) {
                console.log(`   ⚠️  Error fetching posts: ${postsError.message}`);
                console.log(`   💡 Profile information was successfully captured`);
            }
        } else if (profileInfo.is_private) {
            console.log(`🔒 Private account - skipping posts fetch`);
        }

        console.log(`\n✅ Scraped profile with ${allPosts.length} posts`);
        
        return {
            profileUrl,
            username,
            profile: profileInfo,
            posts: allPosts,
            totalPostsFetched: allPosts.length,
            pages: pageCount,
            scrapedAt: new Date().toISOString()
        };
        
    } catch (error) {
        console.error(`\n❌ Error: ${error.message}`);
        throw error;
    }
}

async function saveProfile(result, filename = null) {
    const profilesDir = join(process.cwd(), 'profiles');
    await mkdir(profilesDir, { recursive: true });

    const outputFileName = filename
        ? (isAbsolute(filename) ? basename(filename) : filename)
        : `profile_${result.username}_${Date.now()}.json`;

    const outputPath = join(profilesDir, outputFileName);
    await writeFile(outputPath, JSON.stringify(result, null, 2));
    console.log(`\n💾 Saved: ${outputPath}`);
    return outputPath;
}

// ============================================================================
// Main
// ============================================================================

const PROFILE_URL = 'https://www.instagram.com/psv/'; // Change this to the profile you want to scrape

scrapeProfile(PROFILE_URL, 50, 24)
    .then(async (result) => {
        console.log('\n' + '='.repeat(60));
        console.log('📈 PROFILE SUMMARY');
        console.log('='.repeat(60));
        console.log(`Profile: ${result.profileUrl}`);
        console.log(`Username: @${result.profile.username}`);
        console.log(`Full Name: ${result.profile.full_name || 'Not provided'}`);
        console.log(`Followers: ${result.profile.followers_count.toLocaleString()}`);
        console.log(`Following: ${result.profile.following_count.toLocaleString()}`);
        console.log(`Total Posts: ${result.profile.posts_count.toLocaleString()}`);
        console.log(`Posts Fetched: ${result.totalPostsFetched}`);
        console.log(`Is Private: ${result.profile.is_private ? 'Yes' : 'No'}`);
        console.log(`Is Verified: ${result.profile.is_verified ? 'Yes' : 'No'}`);
        console.log(`Is Business: ${result.profile.is_business_account ? 'Yes' : 'No'}`);
        
        if (result.profile.biography) {
            console.log(`Bio: ${result.profile.biography.substring(0, 100)}${result.profile.biography.length > 100 ? '...' : ''}`);
        }
        
        if (result.posts.length > 0) {
            console.log(`\n📸 Recent Posts Sample:`);
            result.posts.slice(0, 5).forEach((post, i) => {
                console.log(`\n${i + 1}. ${post.url}`);
                console.log(`   Date: ${new Date(post.timestamp * 1000).toLocaleDateString()}`);
                console.log(`   Likes: ${post.likes.toLocaleString()}`);
                console.log(`   Comments: ${post.comments.toLocaleString()}`);
                console.log(`   Type: ${post.is_video ? 'Video' : 'Photo'}`);
                if (post.caption) {
                    console.log(`   Caption: ${post.caption.substring(0, 60)}${post.caption.length > 60 ? '...' : ''}`);
                }
            });
        }
        
        await saveProfile(result);
    })
    .catch(err => {
        console.error('\n💥 Fatal error:', err);
        process.exit(1);
    });