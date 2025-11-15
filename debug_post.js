import puppeteer from 'puppeteer';
import * as dotenv from 'dotenv';
dotenv.config();

const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

(async () => {
    const browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    
    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });
    
    const sessionId = process.env.SESSION;
    if (sessionId) {
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
        
        await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded' });
        await page.setCookie(...cookies);
    }
    
    console.log('Navigating to post...');
    await page.goto('https://www.instagram.com/p/DORgtyWDPJF/', { waitUntil: 'domcontentloaded', timeout: 90000 });
    
    console.log('Waiting 5 seconds...');
    await wait(5000);
    
    const pageContent = await page.content();
    const hasJsonScripts = pageContent.includes('application/json');
    const scriptCount = (pageContent.match(/<script type="application\/json">/g) || []).length;
    
    console.log('Has JSON scripts:', hasJsonScripts);
    console.log('JSON script count:', scriptCount);
    
    const scripts = await page.evaluate(() => {
        const scripts = Array.from(document.querySelectorAll('script[type="application/json"]'));
        return scripts.map((s, i) => ({
            index: i,
            length: s.textContent.length,
            preview: s.textContent.substring(0, 200)
        }));
    });
    
    console.log('\nScripts found:', scripts.length);
    scripts.forEach(s => {
        console.log(`Script ${s.index}: ${s.length} chars`);
        console.log('Preview:', s.preview);
    });
    
    const dataCheck = await page.evaluate(() => {
        const scripts = Array.from(document.querySelectorAll('script[type="application/json"]'));
        
        for (const script of scripts) {
            try {
                const data = JSON.parse(script.textContent);
                const media = data?.require?.[0]?.[3]?.[0]?.__bbox?.require?.[0]?.[3]?.[1]?.__bbox?.result?.data?.xdt_api__v1__media__shortcode__web_info?.items?.[0];
                
                if (media && media.code) {
                    return { found: true, hasCode: true, code: media.code };
                }
            } catch (e) {
                // Check for alternative paths
                if (data?.require) {
                    return { found: true, hasRequire: true, requireLength: data.require.length };
                }
            }
        }
        
        return { found: false };
    });
    
    console.log('\nData check result:', dataCheck);
    
    // Check if we got rate limited
    const pageText = await page.evaluate(() => document.body.innerText);
    console.log('\nPage contains "429":', pageText.includes('429'));
    console.log('Page contains "rate":', pageText.toLowerCase().includes('rate'));
    console.log('Page contains "limit":', pageText.toLowerCase().includes('limit'));
    console.log('Page contains "try again":', pageText.toLowerCase().includes('try again'));
    
    console.log('\nFirst 500 chars of page:', pageText.substring(0, 500));
    
    await wait(3000);
    await browser.close();
})();
