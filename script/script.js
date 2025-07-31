const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');
const Epub = require('epub-gen');
const { promisify } = require('util');
const { setTimeout } = require('timers/promises');

class NovelCrawler {
    constructor(novelUrl, options = {}) {
        this.novelUrl = new URL(novelUrl);
        this.options = {
            concurrency: 5,       // Number of parallel downloads
            delayBetweenRequests: 200, // ms between requests
            retries: 3,           // Number of retries for failed requests
            ...options
        };
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
        const controller = new AbortController();
        const timeout = setTimeout(10000).then(() => controller.abort());
        
        try {
            const response = await fetch(url.toString(), {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
                },
                signal: controller.signal
            });
            
            clearTimeout(timeout);
            
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            
            return cheerio.load(await response.text());
        } catch (error) {
            clearTimeout(timeout);
            throw error;
        }
    }

    async fetchWithRetry(url, retries = this.options.retries) {
        try {
            return await this.fetchPage(url);
        } catch (error) {
            if (retries > 0) {
                await setTimeout(this.options.delayBetweenRequests);
                return this.fetchWithRetry(url, retries - 1);
            }
            throw error;
        }
    }

    async getNovelInfo() {
        const $ = await this.fetchWithRetry(this.novelUrl);
        
        this.novelInfo.title = $('.col-xs-12.col-sm-8.col-md-8.desc h3.title').text().trim();
        this.novelInfo.description = $('.col-xs-12.col-sm-8.col-md-8.desc .desc-text').html()?.trim() || 
                                   $('.col-xs-12.col-sm-8.col-md-8.desc .desc-text').text().trim();
        
        const coverPath = $('.col-xs-12.col-sm-4.col-md-4.info-holder .book img').attr('src');
        if (coverPath) {
            this.novelInfo.cover = new URL(coverPath, this.novelUrl).toString();
        }
        
        this.novelInfo.author = $('.info div:has(h3:contains("Author:")) a')
            .map((i, el) => $(el).text().trim()).get().join(', ');
        
        this.novelInfo.genres = $('.info div:has(h3:contains("Genre:")) a')
            .map((i, el) => $(el).text().trim()).get();
        
        this.novelInfo.status = $('.info div:has(h3:contains("Status:")) a').text().trim();
        
        this.novelInfo.source = $('.info div:has(h3:contains("Source:"))')
            .contents().filter((_, el) => el.nodeType === 3).text().trim();
    }

    async getChapterList(pageUrl = null) {
        const url = pageUrl || this.novelUrl;
        const $ = await this.fetchWithRetry(url);
        
        $('.list-chapter li a').each((i, el) => {
            const chapterUrl = new URL($(el).attr('href'), this.novelUrl);
            const chapterTitle = $(el).find('.chapter-text').text().trim() || $(el).attr('title');
            this.novelInfo.chapters.push({
                title: chapterTitle,
                url: chapterUrl.toString()
            });
        });
        
        const nextPageLink = $('.pagination li.next a').attr('href');
        if (nextPageLink) {
            await this.getChapterList(new URL(nextPageLink, this.novelUrl));
        }
    }

    async processChapter(chapter, index, total) {
        try {
            process.stdout.write(`Fetching ${index + 1}/${total} - ${chapter.title}\r`);
            const content = await this.getChapterContent(chapter.url);
            await setTimeout(this.options.delayBetweenRequests); // Rate limiting
            return { ...chapter, content: content.content };
        } catch (error) {
            console.error(`\nFailed chapter ${index + 1}: ${error.message}`);
            return { ...chapter, content: 'Failed to load content' };
        }
    }

    async getChapterContent(chapterUrl) {
        const $ = await this.fetchWithRetry(new URL(chapterUrl));
        
        const chapterTitle = `${$('.col-xs-12 a.truyen-title').text().trim()} - ${$('.col-xs-12 h2').text().trim()}`;
        
        let content = $('#chapter-content').html() || 'Chapter content not found';
        
        // Clean up content
        content = content
            .replace(/<iframe[^>]*>.*?<\/iframe>/g, '')
            .replace(/<!--.*?-->/gs, '')
            .replace(/<p>\s*<\/p>/g, '')
            .replace(/<img[^>]*>/g, '')
            .replace(/<js[^>]*>/g, '')
            .replace(/<script\b[^>]*>.*?<\/script>/gsi, '')
            .replace(/<noscript\b[^>]*>.*?<\/noscript>/gsi, '')
            .replace(/<div[^>]*class\s*=\s*["']ads[^>]*>.*?<\/div>/gsi, '')
            .replace(/<div[^>]*>\s*<\/div>/gsi, '')
                .replace(/<p>Source: .*?novlove\.com<\/p>/gi, '');
        
        return { title: chapterTitle, content };
    }

    async downloadChaptersParallel() {
        const { concurrency } = this.options;
        const chapters = this.novelInfo.chapters;
        const totalChapters = chapters.length;
        
        console.log(`Downloading ${totalChapters} chapters with ${concurrency} parallel requests...`);
        
        // Process chapters in batches
        for (let i = 0; i < totalChapters; i += concurrency) {
            const batch = chapters.slice(i, i + concurrency);
            const results = await Promise.all(
                batch.map((chapter, idx) => this.processChapter(chapter, i + idx, totalChapters))
            );
            
            // Update chapters with content
            results.forEach((result, idx) => {
                chapters[i + idx] = result;
            });
        }
    }

    getCoverXhtmlContent() {
        return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="en" xml:lang="en">
    <head>
        <title>${this.novelInfo.title}</title>
        <link rel="stylesheet" type="text/css" href="css/epub.css" />
    </head>
    <body>
        <img src="${this.novelInfo.cover}" alt="Cover Image" style="height:auto;width:100%;" title="Cover Image" />
    </body>
</html>`;
    }

    async saveToEpub() {
        const sanitizedTitle = this.novelInfo.title.replace(/[^a-z0-9]/gi, '_');
        const outputPath = path.join(process.cwd(), 'results', `${sanitizedTitle}.epub`);
        
        if (!fs.existsSync(path.dirname(outputPath))) {
            fs.mkdirSync(path.dirname(outputPath), { recursive: true });
        }

        const options = {
            title: this.novelInfo.title,
            author: this.novelInfo.author,
            publisher: this.novelInfo.source,
            cover: this.novelInfo.cover,
            css: "p {font-family:serif;}", 
            content: [
                {
                    title: 'Cover',
                    data: this.getCoverXhtmlContent(),
                    beforeToc: true,
                    filename: 'cover.xhtml'
                },
                {
                    title: 'Information',
                    data: `
                        <h1>${this.novelInfo.title}</h1>
                        <h2>by ${this.novelInfo.author}</h2>
                        <p><strong>Status:</strong> ${this.novelInfo.status}</p>
                        <p><strong>Genres:</strong> ${this.novelInfo.genres.join(', ')}</p>
                        <p><strong>Source:</strong> ${this.novelInfo.source}</p>
                        <h3>Description</h3>
                        ${this.novelInfo.description}
                    `,
                    beforeToc: true
                },
                ...this.novelInfo.chapters.map(chapter => ({
                    title: chapter.title,
                    data: chapter.content
                }))
            ],
            appendChapterTitles: false,
            verbose: true
        };

        await new Epub(options, outputPath).promise;
        console.log(`\nEPUB generated at: ${outputPath}`);
    }

    async crawl() {
        console.log('Fetching novel information...');
        await this.getNovelInfo();
        console.log(`Retrieved info for: ${this.novelInfo.title}`);
        
        console.log('Collecting chapter list...');
        await this.getChapterList();
        console.log(`Found ${this.novelInfo.chapters.length} chapters`);
        
        console.log('Downloading chapters...');
        await this.downloadChaptersParallel();
        
        await this.saveToEpub();
        console.log('Done!');
    }
}

// Main execution
const novelUrl = process.argv[2];
if (!novelUrl) {
    console.error('Please provide a novel URL as an argument');
    process.exit(1);
}

// Optional: Configure parallel download options
const crawler = new NovelCrawler(novelUrl, {
    concurrency: 5,     // Number of parallel downloads (adjust based on server tolerance)
    delayBetweenRequests: 200, // ms between requests to avoid overwhelming server
    retries: 3          // Number of retries for failed requests
});

crawler.crawl().catch(err => {
    console.error('Crawler error:', err);
    process.exit(1);
});
