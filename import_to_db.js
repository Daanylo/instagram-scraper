import mysql from 'mysql2/promise';
import { readFile, readdir } from 'fs/promises';
import { join } from 'path';
import 'dotenv/config';

const DB_CONFIG = {
    host: 'localhost',
    port: 3306,
    user: 'remote',
    password: 'remote',
    database: 'psv_dev'
};

async function getConnection() {
    return await mysql.createConnection(DB_CONFIG);
}

async function importProfile(connection, profileData) {
    const profile = profileData.profile;
    
    const [existing] = await connection.execute(
        'SELECT id FROM instagram_profiles WHERE username = ?',
        [profile.username]
    );

    const profileValues = {
        profileUrl: profileData.profileUrl,
        username: profile.username,
        profile_id: profile.id,
        profile_username: profile.username,
        full_name: profile.full_name,
        biography: profile.biography,
        external_url: profile.external_url,
        followers_count: profile.followers_count,
        following_count: profile.following_count,
        posts_count: profile.posts_count,
        is_private: profile.is_private ? 1 : 0,
        is_verified: profile.is_verified ? 1 : 0,
        is_business_account: profile.is_business_account ? 1 : 0,
        is_professional_account: profile.is_professional_account ? 1 : 0,
        profile_pic_url: profile.profile_pic_url,
        profile_pic_url_hd: profile.profile_pic_url_hd,
        category_name: profile.category_name,
        business_category_name: profile.business_category_name,
        last_updated: profileData.last_updated ? new Date(profileData.last_updated) : new Date(),
        first_scraped: profileData.first_scraped ? new Date(profileData.first_scraped) : new Date()
    };

    if (existing.length > 0) {
        await connection.execute(
            `UPDATE instagram_profiles SET 
                profileUrl = ?, profile_id = ?, full_name = ?, biography = ?, 
                external_url = ?, followers_count = ?, following_count = ?, posts_count = ?,
                is_private = ?, is_verified = ?, is_business_account = ?, is_professional_account = ?,
                profile_pic_url = ?, profile_pic_url_hd = ?, category_name = ?, business_category_name = ?,
                last_updated = ?
            WHERE username = ?`,
            [
                profileValues.profileUrl, profileValues.profile_id, profileValues.full_name,
                profileValues.biography, profileValues.external_url, profileValues.followers_count,
                profileValues.following_count, profileValues.posts_count, profileValues.is_private,
                profileValues.is_verified, profileValues.is_business_account, profileValues.is_professional_account,
                profileValues.profile_pic_url, profileValues.profile_pic_url_hd, profileValues.category_name,
                profileValues.business_category_name, profileValues.last_updated, profile.username
            ]
        );
        console.log(`   🔄 Updated profile: @${profile.username}`);
        return existing[0].id;
    } else {
        const [result] = await connection.execute(
            `INSERT INTO instagram_profiles (
                profileUrl, username, profile_id, profile_username, full_name, biography,
                external_url, followers_count, following_count, posts_count, is_private,
                is_verified, is_business_account, is_professional_account, profile_pic_url,
                profile_pic_url_hd, category_name, business_category_name,
                last_updated, first_scraped
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                profileValues.profileUrl, profileValues.username, profileValues.profile_id,
                profileValues.profile_username, profileValues.full_name, profileValues.biography,
                profileValues.external_url, profileValues.followers_count, profileValues.following_count,
                profileValues.posts_count, profileValues.is_private, profileValues.is_verified,
                profileValues.is_business_account, profileValues.is_professional_account,
                profileValues.profile_pic_url, profileValues.profile_pic_url_hd, profileValues.category_name,
                profileValues.business_category_name, profileValues.last_updated,
                profileValues.first_scraped
            ]
        );
        console.log(`   ➕ Inserted profile: @${profile.username}`);
        return result.insertId;
    }
}

async function importPosts(connection, postsData) {
    let inserted = 0;
    let updated = 0;
    let skipped = 0;

    for (const post of postsData.posts) {
        const [existing] = await connection.execute(
            'SELECT id FROM instagram_posts WHERE shortcode = ?',
            [post.shortcode]
        );

        const postValues = {
            shortcode: post.shortcode,
            post_type: post.post_type || null,
            is_reel: post.is_reel ? 1 : 0,
            taken_at: post.taken_at ? new Date(post.taken_at) : null,
            taken_at_timestamp: post.taken_at_timestamp || null,
            caption: post.caption || null,
            like_count: post.like_count || 0,
            comment_count: post.comment_count || 0,
            video_view_count: post.video_view_count || null,
            media_count: post.media_count || 1,
            location_name: post.location?.name || null,
            location_address: post.location?.address || null,
            location_city: post.location?.city || null,
            location_latitude: post.location?.latitude || null,
            location_longitude: post.location?.longitude || null,
            owner_username: post.owner?.username || null,
            owner_full_name: post.owner?.full_name || null,
            owner_is_verified: post.owner?.is_verified ? 1 : 0,
            owner_is_private: post.owner?.is_private ? 1 : 0,
            accessibility_caption: post.accessibility_caption || null,
            is_paid_partnership: post.is_paid_partnership ? 1 : 0,
            from_api: post.from_api ? 1 : 0,
            url: `https://www.instagram.com/p/${post.shortcode}/`
        };

        try {
            if (existing.length > 0) {
                await connection.execute(
                    `UPDATE instagram_posts SET 
                        post_type = ?, is_reel = ?, taken_at = ?, taken_at_timestamp = ?,
                        caption = ?, like_count = ?, comment_count = ?, video_view_count = ?,
                        media_count = ?, location_name = ?, location_address = ?, location_city = ?,
                        location_latitude = ?, location_longitude = ?, owner_username = ?,
                        owner_full_name = ?, owner_is_verified = ?, owner_is_private = ?,
                        accessibility_caption = ?, is_paid_partnership = ?, url = ?
                    WHERE shortcode = ?`,
                    [
                        postValues.post_type, postValues.is_reel, postValues.taken_at,
                        postValues.taken_at_timestamp, postValues.caption, postValues.like_count,
                        postValues.comment_count, postValues.video_view_count, postValues.media_count,
                        postValues.location_name, postValues.location_address, postValues.location_city,
                        postValues.location_latitude, postValues.location_longitude, postValues.owner_username,
                        postValues.owner_full_name, postValues.owner_is_verified, postValues.owner_is_private,
                        postValues.accessibility_caption, postValues.is_paid_partnership, postValues.url,
                        post.shortcode
                    ]
                );
                updated++;
            } else {
                await connection.execute(
                    `INSERT INTO instagram_posts (
                        shortcode, post_type, is_reel, taken_at, taken_at_timestamp, caption,
                        like_count, comment_count, video_view_count, media_count, location_name,
                        location_address, location_city, location_latitude, location_longitude,
                        owner_username, owner_full_name, owner_is_verified, owner_is_private,
                        accessibility_caption, is_paid_partnership, from_api, url
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    [
                        postValues.shortcode, postValues.post_type, postValues.is_reel,
                        postValues.taken_at, postValues.taken_at_timestamp, postValues.caption,
                        postValues.like_count, postValues.comment_count, postValues.video_view_count,
                        postValues.media_count, postValues.location_name, postValues.location_address,
                        postValues.location_city, postValues.location_latitude, postValues.location_longitude,
                        postValues.owner_username, postValues.owner_full_name, postValues.owner_is_verified,
                        postValues.owner_is_private, postValues.accessibility_caption,
                        postValues.is_paid_partnership, postValues.from_api, postValues.url
                    ]
                );
                inserted++;
            }
        } catch (error) {
            console.error(`   ⚠️  Error with post ${post.shortcode}: ${error.message}`);
            skipped++;
        }
    }

    console.log(`   ➕ Inserted: ${inserted}, 🔄 Updated: ${updated}, ⚠️  Skipped: ${skipped}`);
    return { inserted, updated, skipped };
}

async function importComments(connection, commentsData, shortcode) {
    const [postResult] = await connection.execute(
        'SELECT id FROM instagram_posts WHERE shortcode = ?',
        [shortcode]
    );

    if (postResult.length === 0) {
        console.log(`   ⚠️  Post ${shortcode} not found in database, skipping comments`);
        return { inserted: 0, updated: 0, skipped: commentsData.length };
    }

    const postId = postResult[0].id;
    let inserted = 0;
    let updated = 0;
    let skipped = 0;

    for (const comment of commentsData) {
        const [existing] = await connection.execute(
            'SELECT id FROM instagram_comments WHERE comment_id = ?',
            [comment.id]
        );

        const commentValues = {
            comment_id: comment.id,
            post_id: postId,
            text: comment.text || null,
            created_at: comment.created_at || null,
            owner_id: comment.owner?.id || null,
            owner_username: comment.owner?.username || null,
            owner_is_verified: comment.owner?.is_verified ? 1 : 0,
            owner_profile_pic_url: comment.owner?.profile_pic_url || null,
            likes: comment.likes || 0,
            replies: comment.replies || 0
        };

        try {
            if (existing.length > 0) {
                await connection.execute(
                    `UPDATE instagram_comments SET 
                        text = ?, likes = ?, replies = ?
                    WHERE comment_id = ?`,
                    [commentValues.text, commentValues.likes, commentValues.replies, comment.id]
                );
                updated++;
            } else {
                await connection.execute(
                    `INSERT INTO instagram_comments (
                        comment_id, post_id, text, created_at, owner_id, owner_username,
                        owner_is_verified, owner_profile_pic_url, likes, replies
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    [
                        commentValues.comment_id, commentValues.post_id, commentValues.text,
                        commentValues.created_at, commentValues.owner_id, commentValues.owner_username,
                        commentValues.owner_is_verified, commentValues.owner_profile_pic_url,
                        commentValues.likes, commentValues.replies
                    ]
                );
                inserted++;
            }
        } catch (error) {
            console.error(`   ⚠️  Error with comment ${comment.id}: ${error.message}`);
            skipped++;
        }
    }

    return { inserted, updated, skipped };
}

async function importAllData(username) {
    console.log('\n╔═══════════════════════════════════════════════════════════╗');
    console.log('║   Instagram Data → Database Importer                     ║');
    console.log('╚═══════════════════════════════════════════════════════════╝\n');

    const connection = await getConnection();
    console.log('✅ Connected to database\n');

    const stats = {
        profiles: { inserted: 0, updated: 0 },
        posts: { inserted: 0, updated: 0, skipped: 0 },
        comments: { inserted: 0, updated: 0, skipped: 0 }
    };

    try {
        console.log('📊 Importing Profile Data...');
        const profilePath = join(process.cwd(), 'profiles', `profile_${username}.json`);
        try {
            const profileContent = await readFile(profilePath, 'utf-8');
            const profileData = JSON.parse(profileContent);
            await importProfile(connection, profileData);
            stats.profiles.updated = 1;
        } catch (error) {
            console.log(`   ⚠️  Profile not found or error: ${error.message}`);
        }

        console.log('\n📸 Importing Posts Data...');
        const postsPath = join(process.cwd(), 'posts', `posts_${username}.json`);
        try {
            const postsContent = await readFile(postsPath, 'utf-8');
            const postsData = JSON.parse(postsContent);
            const postStats = await importPosts(connection, postsData);
            stats.posts = postStats;
        } catch (error) {
            console.log(`   ⚠️  Posts not found or error: ${error.message}`);
        }

        console.log('\n💬 Importing Comments Data...');
        const commentsDir = join(process.cwd(), 'comments');
        try {
            const files = await readdir(commentsDir);
            const commentFiles = files.filter(f => f.startsWith('comments_') && f.endsWith('.json'));
            
            console.log(`   Found ${commentFiles.length} comment files`);
            
            for (const file of commentFiles) {
                const shortcode = file.replace('comments_', '').replace('.json', '');
                const commentPath = join(commentsDir, file);
                
                try {
                    const commentContent = await readFile(commentPath, 'utf-8');
                    const commentsData = JSON.parse(commentContent);
                    
                    const commentStats = await importComments(connection, commentsData, shortcode);
                    stats.comments.inserted += commentStats.inserted;
                    stats.comments.updated += commentStats.updated;
                    stats.comments.skipped += commentStats.skipped;
                    
                    console.log(`   ✓ ${shortcode}: +${commentStats.inserted} updated:${commentStats.updated}`);
                } catch (error) {
                    console.log(`   ⚠️  Error with ${file}: ${error.message}`);
                }
            }
        } catch (error) {
            console.log(`   ⚠️  Comments directory not found or error: ${error.message}`);
        }

        console.log('\n' + '═'.repeat(60));
        console.log('📊 IMPORT SUMMARY');
        console.log('═'.repeat(60));
        console.log(`Profiles:  Updated ${stats.profiles.updated}`);
        console.log(`Posts:     Inserted ${stats.posts.inserted}, Updated ${stats.posts.updated}, Skipped ${stats.posts.skipped}`);
        console.log(`Comments:  Inserted ${stats.comments.inserted}, Updated ${stats.comments.updated}, Skipped ${stats.comments.skipped}`);
        console.log('\n✅ Database import completed!\n');

    } finally {
        await connection.end();
    }
}

const args = process.argv.slice(2);
const username = args[0];

if (!username) {
    console.error('❌ Usage: node import_to_db.js <username>');
    console.error('   Example: node import_to_db.js psv');
    console.error('\n   This will import all data for the specified username from:');
    console.error('   - profiles/profile_<username>.json');
    console.error('   - posts/posts_<username>.json');
    console.error('   - comments/comments_*.json (all comments)');
    process.exit(1);
}

importAllData(username)
    .catch(error => {
        console.error('\n💥 Import error:', error);
        process.exit(1);
    });
