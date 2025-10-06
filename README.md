# Instagram Post Scraper

A tool to scrape detailed information from Instagram posts using browser automation.

## Files

- `scrape_profile.js` - Scrape profile information (username, bio, followers, etc.)
- `scrape_urls.js` - Get post URLs from a profile
- `scrape_posts.js` - Scrape detailed post information (requires Puppeteer)
- `scrape_comments.js` - Scrape comments from posts

## Installation

```bash
npm install
```

## Usage

### 1. Get Post URLs from a Profile

```bash
node scrape_urls.js <username> <count>
# Example:
node scrape_urls.js psv 10
```

This will save URLs to `post-urls/urls_<username>_<timestamp>.json`

### 2. Scrape Post Details

```bash
node scrape_posts.js <url_file_or_post_url> [delay_ms]
# Example with URL file:
node scrape_posts.js ./post-urls/urls_psv_123456.json 2000

# Example with single URL:
node scrape_posts.js https://www.instagram.com/p/ABC123/ 2000
```

This will save post data to `posts/posts_<username>_<timestamp>.json`

## Post Data Extracted

- Post URL and shortcode
- Post type (photo/video/carousel/reel)
- Date/time posted
- Caption text
- Hashtags and mentions
- Location information
- Engagement metrics:
  - Like count
  - Comment count
  - View count (for videos/reels)
- Media URLs
- Owner information

## Requirements

- Node.js 14+
- Puppeteer (for post scraping)

## Notes

- Instagram aggressively blocks automated scraping
- The post scraper uses browser automation to bypass detection
- Add delays between requests to avoid rate limiting
- Some data may not be available for all posts

## Output Example

```json
{
  "posts": [
    {
      "shortcode": "ABC123",
      "url": "https://www.instagram.com/p/ABC123/",
      "post_type": "photo",
      "taken_at": "2025-01-15T10:30:00.000Z",
      "caption": "Amazing sunset! #sunset",
      "hashtags": ["sunset"],
      "like_count": 1234,
      "comment_count": 56,
      "owner": {
        "username": "example_user",
        "is_verified": false
      }
    }
  ],
  "total_scraped": 1,
  "scraped_at": "2025-10-06T17:00:00.000Z"
}
```
