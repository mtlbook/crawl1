const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');
const epub = require('epub-gen-memory').default;  // Note the .default here

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

    async generateEPUB() {
        // First prepare the chapters array
        const chapters = [];
        
        // Add metadata as first chapter
        chapters.push({
            title: 'Metadata',
            data: `
                <h1>${this.novelInfo.title}</h1>
                <h2>by ${this.novelInfo.author}</h2>
                <p><strong>Status:</strong> ${this.novelInfo.status}</p>
                <p><strong>Genres:</strong> ${this.novelInfo.genres.join(', ')}</p>
                <p><strong>Source:</strong> ${this.novelInfo.source}</p>
                <h3>Description</h3>
                <p>${this.novelInfo.description}</p>
            `,
            excludeFromToc: false,
            beforeToc: false
        });
        
        // Add all novel chapters
        for (const chapter of this.novelInfo.chapters) {
            console.log(`Fetching chapter: ${chapter.title}`);
            const chapterContent = await this.getChapterContent(chapter.url);
            chapters.push({
                title: chapterContent.title,
                data: chapterContent.content,
                excludeFromToc: false,
                beforeToc: false
            });
        }
        
        // Prepare options for EPUB generation
        const options = {
            title: this.novelInfo.title,
            author: this.novelInfo.author,
            description: this.novelInfo.description,
            publisher: this.novelInfo.source,
            cover: this.novelInfo.cover,
            content: chapters,  // Pass the prepared chapters array here
            verbose: true  // Enable verbose logging for debugging
        };
        
        // Generate EPUB
        const outputPath = path.join(process.cwd(), 'results', `${this.novelInfo.title.replace(/[^a-z0-9]/gi, '_')}.epub`);
        
        try {
            // Generate EPUB buffer
            const epubBuffer = await epub(options);
            
            // Write the buffer to file
            fs.writeFileSync(outputPath, epubBuffer);
            console.log(`EPUB generated at: ${outputPath}`);
            
            // Verify file was created
            if (!fs.existsSync(outputPath)) {
                throw new Error('EPUB file was not created');
            }
        } catch (err) {
            console.error('EPUB generation failed:', err);
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
        
        await this.generateEPUB();
    }
}

// Get URL from command line arguments
const novelUrl = process.argv[2];
if (!novelUrl) {
    console.error('Please provide a novel URL as an argument');
    process.exit(1);
}

// Create results directory if it doesn't exist
const resultsDir = path.join(__dirname, '../results');
if (!fs.existsSync(resultsDir)) {
    fs.mkdirSync(resultsDir);
}

// Run crawler
const crawler = new NovelCrawler(novelUrl);
crawler.crawl().catch(err => {
    console.error('Crawler error:', err);
    process.exit(1);
});
