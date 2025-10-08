import { execSync } from 'child_process';
import { readFile } from 'fs/promises';
import { join } from 'path';

const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function runCommand(command, description) {
    console.log(`\n${'='.repeat(70)}`);
    console.log(`📍 STEP: ${description}`);
    console.log(`${'='.repeat(70)}`);
    console.log(`🔧 Running: ${command}\n`);
    
    try {
        const output = execSync(command, { 
            encoding: 'utf-8',
            stdio: 'inherit',
            cwd: process.cwd()
        });
        console.log(`\n✅ Completed: ${description}`);
        return true;
    } catch (error) {
        console.error(`\n❌ Failed: ${description}`);
        console.error(`Error: ${error.message}`);
        return false;
    }
}

async function loadJsonFile(filePath) {
    try {
        const content = await readFile(filePath, 'utf-8');
        return JSON.parse(content);
    } catch (error) {
        console.error(`❌ Could not load ${filePath}: ${error.message}`);
        return null;
    }
}

async function runPipeline(username, options = {}) {
    const {
        maxUrls = 12,
        maxProfilePosts = 50,
        maxComments = 1000,
        postDelay = 3000,
        stepDelay = 2000
    } = options;

    console.log('\n' + '█'.repeat(70));
    console.log('🚀 INSTAGRAM SCRAPING PIPELINE');
    console.log('█'.repeat(70));
    console.log(`\n📌 Target: @${username}`);
    console.log(`📊 Settings:`);
    console.log(`   - Max URLs to fetch: ${maxUrls}`);
    console.log(`   - Max profile posts: ${maxProfilePosts}`);
    console.log(`   - Max comments per post: ${maxComments}`);
    console.log(`   - Post scraping delay: ${postDelay}ms`);
    console.log(`\n⏱️  Started: ${new Date().toISOString()}\n`);

    const startTime = Date.now();
    const results = {
        profile: null,
        urls: null,
        posts: null,
        comments: []
    };

    console.log('\n' + '▶'.repeat(70));
    console.log('STEP 1/4: PROFILE SCRAPING');
    console.log('▶'.repeat(70));
    
    const profileSuccess = runCommand(
        `node scrape_profile.js ${username} ${maxProfilePosts}`,
        'Scrape profile information and posts'
    );

    if (!profileSuccess) {
        console.error('\n💥 Pipeline failed at profile scraping');
        process.exit(1);
    }

    await wait(stepDelay);

    const profilePath = join(process.cwd(), 'profiles', `profile_${username}.json`);
    results.profile = await loadJsonFile(profilePath);
    
    if (results.profile) {
        console.log(`\n📊 Profile Summary:`);
        console.log(`   - Username: @${results.profile.username}`);
        console.log(`   - Posts fetched: ${results.profile.totalPostsFetched}`);
    }

    console.log('\n' + '▶'.repeat(70));
    console.log('STEP 2/4: POST URL SCRAPING (Puppeteer)');
    console.log('▶'.repeat(70));

    const urlsSuccess = runCommand(
        `node scrape_urls.js ${username} ${maxUrls}`,
        'Scrape post URLs using browser automation'
    );

    if (!urlsSuccess) {
        console.error('\n💥 Pipeline failed at URL scraping');
        process.exit(1);
    }

    await wait(stepDelay);

    const urlsPath = join(process.cwd(), 'post-urls', `urls_${username}.json`);
    results.urls = await loadJsonFile(urlsPath);

    if (!results.urls || results.urls.post_urls.length === 0) {
        console.error('\n💥 No URLs found to scrape posts');
        process.exit(1);
    }

    console.log(`\n📊 URLs Summary:`);
    console.log(`   - Total URLs: ${results.urls.post_urls.length}`);

    console.log('\n' + '▶'.repeat(70));
    console.log('STEP 3/4: POST SCRAPING (Puppeteer)');
    console.log('▶'.repeat(70));

    const postsSuccess = runCommand(
        `node scrape_posts.js ${urlsPath} ${postDelay}`,
        'Scrape detailed post information using browser automation'
    );

    if (!postsSuccess) {
        console.error('\n💥 Pipeline failed at post scraping');
        process.exit(1);
    }

    await wait(stepDelay);

    const postsPath = join(process.cwd(), 'posts', `posts_${username}.json`);
    results.posts = await loadJsonFile(postsPath);

    if (results.posts) {
        console.log(`\n📊 Posts Summary:`);
        console.log(`   - Total posts scraped: ${results.posts.total_scraped}`);
        console.log(`   - Errors: ${results.posts.total_errors}`);
    }

    console.log('\n' + '▶'.repeat(70));
    console.log('STEP 4/4: COMMENT SCRAPING (Batch Mode)');
    console.log('▶'.repeat(70));

    if (!results.urls || results.urls.post_urls.length === 0) {
        console.log('\n⚠️  No URLs available for comment scraping');
    } else {
        console.log(`\n📝 Scraping comments from ${results.urls.post_urls.length} posts in batch mode...`);
        
        const commentsSuccess = runCommand(
            `node scrape_comments.js ${urlsPath} ${maxComments}`,
            'Scrape comments from all posts using authenticated API'
        );

        if (commentsSuccess) {
            console.log(`\n✅ Batch comment scraping completed`);
            results.comments.push({ status: 'success', posts: results.urls.post_urls.length });
        } else {
            console.log(`\n⚠️  Batch comment scraping had some issues`);
            results.comments.push({ status: 'partial', posts: results.urls.post_urls.length });
        }
    }

    const endTime = Date.now();
    const duration = Math.round((endTime - startTime) / 1000);

    console.log('\n' + '█'.repeat(70));
    console.log('✅ PIPELINE COMPLETE!');
    console.log('█'.repeat(70));
    console.log(`\n⏱️  Finished: ${new Date().toISOString()}`);
    console.log(`⏱️  Duration: ${duration} seconds (${Math.round(duration / 60)} minutes)`);
    console.log(`\n📁 Output Files:`);
    console.log(`   - Profile: profiles/profile_${username}.json`);
    console.log(`   - URLs: post-urls/urls_${username}.json`);
    console.log(`   - Posts: posts/posts_${username}.json`);
    console.log(`   - Comments: comments/comments_*.json`);
    
    console.log(`\n📊 Final Summary:`);
    if (results.profile) {
        console.log(`   - Profile posts: ${results.profile.totalPostsFetched}`);
    }
    if (results.urls) {
        console.log(`   - URLs collected: ${results.urls.post_urls.length}`);
    }
    if (results.posts) {
        console.log(`   - Posts scraped: ${results.posts.total_scraped}`);
    }
    if (results.comments.length > 0 && results.comments[0].posts) {
        console.log(`   - Comment scraping: ${results.comments[0].status} (${results.comments[0].posts} posts)`);
    }

    console.log('\n🎉 All data collected successfully!\n');
}

const args = process.argv.slice(2);

if (args.length === 0) {
    console.log(`
╔════════════════════════════════════════════════════════════════════╗
║              Instagram Scraping Pipeline                          ║
╚════════════════════════════════════════════════════════════════════╝

Usage: node scrape_pipeline.js <username> [options]

Arguments:
  username          Instagram username to scrape (required)

Options:
  --max-urls        Maximum URLs to fetch (default: 12)
  --max-posts       Maximum profile posts (default: 50)
  --max-comments    Maximum comments per post (default: 1000)
  --post-delay      Delay between posts in ms (default: 3000)
  --step-delay      Delay between pipeline steps in ms (default: 2000)

Examples:
  node scrape_pipeline.js psv
  node scrape_pipeline.js instagram --max-urls 20 --max-comments 500
  node scrape_pipeline.js brand_account --max-posts 100 --post-delay 5000

Pipeline Steps:
  1. 📊 Scrape profile information and posts (API with auth)
  2. 🔗 Scrape post URLs (Puppeteer with auth)
  3. 📸 Scrape detailed post data (Puppeteer)
  4. 💬 Scrape comments from all posts (API batch mode with auth)

All data is saved to respective folders with single-file deduplication.
Note: Requires SESSION variable in .env file for authentication.
`);
    process.exit(0);
}

const username = args[0];
const options = {};

for (let i = 1; i < args.length; i++) {
    switch (args[i]) {
        case '--max-urls':
            options.maxUrls = parseInt(args[++i]);
            break;
        case '--max-posts':
            options.maxProfilePosts = parseInt(args[++i]);
            break;
        case '--max-comments':
            options.maxComments = parseInt(args[++i]);
            break;
        case '--post-delay':
            options.postDelay = parseInt(args[++i]);
            break;
        case '--step-delay':
            options.stepDelay = parseInt(args[++i]);
            break;
    }
}

runPipeline(username, options)
    .catch(error => {
        console.error('\n💥 Pipeline error:', error);
        process.exit(1);
    });
