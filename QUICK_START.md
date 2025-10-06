# Quick Start Guide

## 🚀 Installation

```bash
npm install
```

## 📖 Usage Examples

### Get Post URLs
```bash
npm run urls psv 10
```
Output: `post-urls/urls_psv_<timestamp>.json`

### Scrape Posts
```bash
npm run posts post-urls/urls_psv_<timestamp>.json
```
Output: `posts/posts_psv_<timestamp>.json`

### Scrape Single Post
```bash
npm run posts https://www.instagram.com/p/DPeGrDmjA9R/
```

### Scrape Profile
```bash
npm run profile psv
```
Output: `profiles/profile_psv_<timestamp>.json`

### Scrape Comments
```bash
npm run comments https://www.instagram.com/p/DPeGrDmjA9R/
```
Output: `comments/comments_<shortcode>_<timestamp>.json`

## ⚙️ Advanced Options

### Custom Delay Between Requests
```bash
node scrape_posts.js post-urls/urls_psv_123.json 5000
```

### Show Browser (Debug Mode)
```bash
node scrape_posts.js post-urls/urls_psv_123.json 3000 --show-browser
```

## 📊 What Gets Extracted

✅ **Posts**: shortcode, type, date, caption, hashtags, mentions, location, likes, comments, views  
✅ **Profile**: username, full name, bio, followers, following, post count, profile pic  
✅ **Comments**: text, author, timestamp, likes, replies  
✅ **URLs**: List of post URLs from profile feed  

## 🎯 Output Structure

All output is saved as JSON in organized directories:
- `profiles/` - Profile data
- `post-urls/` - URL lists
- `posts/` - Detailed post data
- `comments/` - Comment threads

## ⚠️ Tips

- Use 3000ms delay minimum between requests
- Instagram may rate limit aggressive scraping
- Works best with public profiles/posts
- No login required
