const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');

class NovelCrawler {
    constructor(baseUrl) {
        this.baseUrl = new URL('https://novgo.net');
        this.novelUrl = new URL(baseUrl);
        this.novelInfo = {
            title: '',
            description: '',
            cover: '',
            author: '',
            genres: [],
            status: '',
            source: '',
            chapters: []
        };
    }

    async fetchPage(url) {
        try {
            const response = await axios.get(url.toString(), {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
                }
            });
            return cheerio.load(response.data);
        } catch (error) {
            console.error(`Error fetching ${url}:`, error.message);
            throw error;
        }
    }

    async getNovelInfo() {
        const $ = await this.fetchPage(this.novelUrl);
        
        // Extract novel info
        this.novelInfo.title = $('.col-xs-12.col-sm-8.col-md-8.desc h3.title').text().trim();
        this.novelInfo.description = $('.col-xs-12.col-sm-8.col-md-8.desc .desc-text').text().trim();
        
        // Extract cover image
        const coverPath = $('.col-xs-12.col-sm-4.col-md-4.info-holder .book img').attr('src');
        if (coverPath) {
            this.novelInfo.cover = new URL(coverPath, this.baseUrl).toString();
        }
        
        // Extract author
        const authors = [];
        $('.info div:has(h3:contains("Author:")) a').each((i, el) => {
            authors.push($(el).text().trim());
        });
        this.novelInfo.author = authors.join(', ');
        
        // Extract genres
        $('.info div:has(h3:contains("Genre:")) a').each((i, el) => {
            this.novelInfo.genres.push($(el).text().trim());
        });
        
        // Extract status
        this.novelInfo.status = $('.info div:has(h3:contains("Status:")) a').text().trim();
        
        // Extract source
        this.novelInfo.source = $('.info div:has(h3:contains("Source:"))').contents().filter(function() {
            return this.nodeType === 3; // Text nodes
        }).text().trim();
    }

    async getChapterList(pageUrl = null) {
        const url = pageUrl || this.novelUrl;
        const $ = await this.fetchPage(url);
        
        // Extract chapters from current page
        $('.list-chapter li a').each((i, el) => {
            const chapterUrl = new URL($(el).attr('href'), this.baseUrl);
            const chapterTitle = $(el).find('.chapter-text').text().trim() || $(el).attr('title');
            this.novelInfo.chapters.push({
                title: chapterTitle,
                url: chapterUrl.toString()
            });
        });
        
        // Check for pagination
        const nextPageLink = $('.pagination li.next a').attr('href');
        if (nextPageLink) {
            const nextPageUrl = new URL(nextPageLink, this.baseUrl);
            await this.getChapterList(nextPageUrl);
        }
    }

    async getChapterContent(chapterUrl) {
        const $ = await this.fetchPage(new URL(chapterUrl));
        
        const chapterTitle = $('.col-xs-12 a.truyen-title').text().trim() + ' - ' + 
                           $('.col-xs-12 h2').text().trim();
        
        let content = $('.cha-content .cha-words').html();
        if (!content) {
            content = 'Chapter content not found';
        }
        
        return {
            title: chapterTitle,
            content: content
        };
    }

    async saveToJson() {
        const outputPath = path.join(process.cwd(), 'results', `${this.novelInfo.title.replace(/[^a-z0-9]/gi, '_')}.json`);
        
        try {
            // Create results directory if it doesn't exist
            if (!fs.existsSync(path.dirname(outputPath))) {
                fs.mkdirSync(path.dirname(outputPath), { recursive: true });
            }
            
            // Save novel info as JSON
            fs.writeFileSync(outputPath, JSON.stringify(this.novelInfo, null, 2));
            console.log(`Novel data saved to: ${outputPath}`);
            
            // Verify file was created
            if (!fs.existsSync(outputPath)) {
                throw new Error('JSON file was not created');
            }
        } catch (err) {
            console.error('Failed to save JSON:', err);
            throw err;
        }
    }

    async crawl() {
        await this.getNovelInfo();
        console.log('Novel info retrieved:', {
            title: this.novelInfo.title,
            author: this.novelInfo.author
        });
        
        await this.getChapterList();
        console.log(`Found ${this.novelInfo.chapters.length} chapters`);
        
        // Fetch content for first few chapters (optional)
        // You might want to limit this as fetching all chapters could take a long time
        const maxChaptersToFetch = 5; // Change this as needed
        for (let i = 0; i < Math.min(this.novelInfo.chapters.length, maxChaptersToFetch); i++) {
            const chapter = this.novelInfo.chapters[i];
            console.log(`Fetching content for chapter ${i + 1}: ${chapter.title}`);
            const content = await this.getChapterContent(chapter.url);
            chapter.content = content.content;
        }
        
        await this.saveToJson();
    }
}

// Get URL from command line arguments
const novelUrl = process.argv[2];
if (!novelUrl) {
    console.error('Please provide a novel URL as an argument');
    process.exit(1);
}

// Run crawler
const crawler = new NovelCrawler(novelUrl);
crawler.crawl().catch(err => {
    console.error('Crawler error:', err);
    process.exit(1);
});
