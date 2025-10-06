import { execSync } from 'child_process';
import { readFile } from 'fs/promises';
import { join } from 'path';

// ============================================================================
// Instagram Scraping Pipeline
// Orchestrates: Profile → URLs → Posts → Comments
// ============================================================================

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

    // ========================================================================
    // STEP 1: Scrape Profile
    // ========================================================================
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

    // Load profile results
    const profilePath = join(process.cwd(), 'profiles', `profile_${username}.json`);
    results.profile = await loadJsonFile(profilePath);
    
    if (results.profile) {
        console.log(`\n📊 Profile Summary:`);
        console.log(`   - Username: @${results.profile.username}`);
        console.log(`   - Posts fetched: ${results.profile.totalPostsFetched}`);
    }

    // ========================================================================
    // STEP 2: Scrape Post URLs
    // ========================================================================
    console.log('\n' + '▶'.repeat(70));
    console.log('STEP 2/4: POST URL SCRAPING');
    console.log('▶'.repeat(70));

    const urlsSuccess = runCommand(
        `node scrape_urls.js ${username} ${maxUrls}`,
        'Scrape post URLs'
    );

    if (!urlsSuccess) {
        console.error('\n💥 Pipeline failed at URL scraping');
        process.exit(1);
    }

    await wait(stepDelay);

    // Load URLs
    const urlsPath = join(process.cwd(), 'post-urls', `urls_${username}.json`);
    results.urls = await loadJsonFile(urlsPath);

    if (!results.urls || results.urls.post_urls.length === 0) {
        console.error('\n💥 No URLs found to scrape posts');
        process.exit(1);
    }

    console.log(`\n📊 URLs Summary:`);
    console.log(`   - Total URLs: ${results.urls.post_urls.length}`);

    // ========================================================================
    // STEP 3: Scrape Posts
    // ========================================================================
    console.log('\n' + '▶'.repeat(70));
    console.log('STEP 3/4: POST SCRAPING');
    console.log('▶'.repeat(70));

    const postsSuccess = runCommand(
        `node scrape_posts.js ${urlsPath} ${postDelay}`,
        'Scrape detailed post information'
    );

    if (!postsSuccess) {
        console.error('\n💥 Pipeline failed at post scraping');
        process.exit(1);
    }

    await wait(stepDelay);

    // Load posts
    const postsPath = join(process.cwd(), 'posts', `posts_${username}.json`);
    results.posts = await loadJsonFile(postsPath);

    if (results.posts) {
        console.log(`\n📊 Posts Summary:`);
        console.log(`   - Total posts scraped: ${results.posts.total_scraped}`);
        console.log(`   - Errors: ${results.posts.total_errors}`);
    }

    // ========================================================================
    // STEP 4: Scrape Comments
    // ========================================================================
    console.log('\n' + '▶'.repeat(70));
    console.log('STEP 4/4: COMMENT SCRAPING');
    console.log('▶'.repeat(70));

    if (!results.urls || results.urls.post_urls.length === 0) {
        console.log('\n⚠️  No URLs available for comment scraping');
    } else {
        console.log(`\n📝 Scraping comments from ${results.urls.post_urls.length} posts...`);
        
        let commentSuccessCount = 0;
        let commentFailCount = 0;

        for (let i = 0; i < results.urls.post_urls.length; i++) {
            const url = results.urls.post_urls[i];
            console.log(`\n[${i + 1}/${results.urls.post_urls.length}] ${url}`);

            const success = runCommand(
                `node scrape_comments.js ${url} ${maxComments}`,
                `Scrape comments from post ${i + 1}`
            );

            if (success) {
                commentSuccessCount++;
                results.comments.push({ url, status: 'success' });
            } else {
                commentFailCount++;
                results.comments.push({ url, status: 'failed' });
            }

            // Delay between comment scraping
            if (i < results.urls.post_urls.length - 1) {
                console.log(`\n⏳ Waiting ${stepDelay}ms before next post...`);
                await wait(stepDelay);
            }
        }

        console.log(`\n📊 Comments Summary:`);
        console.log(`   - Successfully scraped: ${commentSuccessCount} posts`);
        console.log(`   - Failed: ${commentFailCount} posts`);
    }

    // ========================================================================
    // PIPELINE COMPLETE
    // ========================================================================
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
    console.log(`   - Comment files created: ${results.comments.filter(c => c.status === 'success').length}`);

    console.log('\n🎉 All data collected successfully!\n');
}

// ============================================================================
// Main
// ============================================================================

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
  1. 📊 Scrape profile information and posts
  2. 🔗 Scrape post URLs
  3. 📸 Scrape detailed post data
  4. 💬 Scrape comments from all posts

All data is saved to respective folders with single-file deduplication.
`);
    process.exit(0);
}

const username = args[0];
const options = {};

// Parse command line options
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

// Run the pipeline
runPipeline(username, options)
    .catch(error => {
        console.error('\n💥 Pipeline error:', error);
        process.exit(1);
    });
