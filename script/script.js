const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');
const Epub = require('epub-gen');

class NovelCrawler {
    constructor(novelUrl) {
        this.novelUrl = new URL(novelUrl);
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
        
        this.novelInfo.title = $('.col-xs-12.col-sm-8.col-md-8.desc h3.title').text().trim();
        
        const descElement = $('.col-xs-12.col-sm-8.col-md-8.desc .desc-text');
        this.novelInfo.description = descElement.html() || descElement.text().trim();
        
        const coverPath = $('.col-xs-12.col-sm-4.col-md-4.info-holder .book img').attr('src');
        if (coverPath) {
            this.novelInfo.cover = new URL(coverPath, this.novelUrl).toString();
        }
        
        const authors = [];
        $('.info div:has(h3:contains("Author:")) a').each((i, el) => {
            authors.push($(el).text().trim());
        });
        this.novelInfo.author = authors.join(', ');
        
        $('.info div:has(h3:contains("Genre:")) a').each((i, el) => {
            this.novelInfo.genres.push($(el).text().trim());
        });
        
        this.novelInfo.status = $('.info div:has(h3:contains("Status:")) a').text().trim();
        
        this.novelInfo.source = $('.info div:has(h3:contains("Source:"))').contents().filter(function() {
            return this.nodeType === 3;
        }).text().trim();
    }

    async getChapterList(pageUrl = null) {
        const url = pageUrl || this.novelUrl;
        const $ = await this.fetchPage(url);
        
        $('.list-chapter li a').each((i, el) => {
            const chapterUrl = new URL($(el).attr('href'), this.novelUrl);
            const chapterTitle = $(el).find('.chapter-text').text().trim() || $(el).attr('title');
            this.novelInfo.chapters.push({
                title: chapterTitle,
                url: chapterUrl.toString() // Only used temporarily for fetching
            });
        });
        
        const nextPageLink = $('.pagination li.next a').attr('href');
        if (nextPageLink) {
            await this.getChapterList(new URL(nextPageLink, this.novelUrl));
        }
    }

    async getChapterContent(chapterUrl) {
        const $ = await this.fetchPage(new URL(chapterUrl));
        
        const chapterTitle = $('.col-xs-12 a.truyen-title').text().trim() + ' - ' + 
                           $('.col-xs-12 h2').text().trim();
        
        let content = $('#chapter-content').html();
        
        if (content) {
            content = content.replace(/<iframe[^>]*>.*?<\/iframe>/g, '')
                           .replace(/<!--.*?-->/gs, '')
                           .replace(/<p>\s*<\/p>/g, '')     
                           .replace(/<img[^>]*>/g, '')
                           .replace(/<js[^>]*>/g, '')
                  .replace(/<script\b[^>]*>.*?<\/script>/gsi, '')
                .replace(/<noscript\b[^>]*>.*?<\/noscript>/gsi, '')
                            .replace(/<div[^>]*class\s*=\s*["']ads[^>]*>.*?<\/div>/gsi, '')
                            .replace(/<div[^>]*>\s*<\/div>/gsi, '');
        } else {
            content = 'Chapter content not found';
        }
        
        return {
            title: chapterTitle,
            content: content
        };
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
        <img src="cover.jpeg" alt="Cover Image" style="height:auto;width:100%;" title="Cover Image" />
    </body>
</html>`;
    }

    async saveToEpub() {
        const sanitizedTitle = this.novelInfo.title.replace(/[^a-z0-9]/gi, '_');
        const outputPath = path.join(process.cwd(), 'results', `${sanitizedTitle}.epub`);
        
        try {
            if (!fs.existsSync(path.dirname(outputPath))) {
                fs.mkdirSync(path.dirname(outputPath), { recursive: true });
            }

            const options = {
                title: this.novelInfo.title,
                author: this.novelInfo.author,
                publisher: this.novelInfo.source,
                cover: false,
                content: [
                    {
                        title: 'Cover',
                        data: this.getCoverXhtmlContent(),
                        beforeToc: true,
                        filename: 'cover.xhtml',
                          images: [{
                url: this.novelInfo.cover,
                name: 'cover.jpeg'
            }]
                    },
                    {
                        title: 'Metadata',
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

            // Generate EPUB
            await new Epub(options, outputPath).promise;
            console.log(`EPUB generated at: ${outputPath}`);
        } catch (err) {
            console.error('Failed to generate EPUB:', err);
            throw err;
        }
    }

    async crawl() {
        await this.getNovelInfo();
        console.log(`Retrieved info for: ${this.novelInfo.title}`);
        
        await this.getChapterList();
        console.log(`Found ${this.novelInfo.chapters.length} chapters`);
        
        for (let i = 0; i < this.novelInfo.chapters.length; i++) {
            const chapter = this.novelInfo.chapters[i];
            process.stdout.write(`Fetching ${i+1}/${this.novelInfo.chapters.length}\r`);
            
            try {
                const content = await this.getChapterContent(chapter.url);
                chapter.content = content.content;
                await new Promise(resolve => setTimeout(resolve, 100));
            } catch (err) {
                console.error(`\nFailed chapter ${i+1}:`, err.message);
                chapter.content = 'Failed to load content';
            }
        }
        
        await this.saveToEpub();
        console.log('\nDone!');
    }
}

// Main execution
const novelUrl = process.argv[2];
if (!novelUrl) {
    console.error('Please provide a novel URL as an argument');
    process.exit(1);
}

new NovelCrawler(novelUrl).crawl().catch(err => {
    console.error('Crawler error:', err);
    process.exit(1);
});
