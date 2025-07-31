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
            cover: '', // Remote URL for the cover
            author: '',
            genres: [],
            status: '',
            source: '',
            chapters: []
        };
        // Path to the locally saved cover image
        this.localCoverPath = '';
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

    async downloadCover() {
        if (!this.novelInfo.cover) {
            console.log('[COVER] No cover URL found in novel info. Skipping download.');
            return;
        }

        console.log(`[COVER] Found cover URL: ${this.novelInfo.cover}`);
        
        const sanitizedTitle = this.novelInfo.title.replace(/[^a-z0-9]/gi, '_');
        const coverFileName = `${sanitizedTitle}_cover.jpg`;
        const coverDir = path.join(process.cwd(), 'results');
        // Ensure the path is absolute for reliability
        this.localCoverPath = path.resolve(coverDir, coverFileName);

        console.log(`[COVER] Preparing to download cover to: ${this.localCoverPath}`);

        try {
            // Ensure the directory exists
            if (!fs.existsSync(coverDir)) {
                fs.mkdirSync(coverDir, { recursive: true });
            }

            const writer = fs.createWriteStream(this.localCoverPath);

            const response = await axios({
                method: 'get',
                url: this.novelInfo.cover,
                responseType: 'stream'
            });

            response.data.pipe(writer);

            return new Promise((resolve, reject) => {
                writer.on('finish', () => {
                    // *** CRITICAL VALIDATION STEP ***
                    try {
                        const stats = fs.statSync(this.localCoverPath);
                        console.log(`[COVER] SUCCESS: File downloaded successfully.`);
                        console.log(`[COVER] File size: ${stats.size} bytes.`);
                        if (stats.size === 0) {
                            console.error("[COVER] ERROR: Cover downloaded but is an empty file (0 bytes).");
                            this.localCoverPath = ''; // Invalidate the path
                        }
                        resolve();
                    } catch (e) {
                        console.error(`[COVER] ERROR: Download reported as finished, but file cannot be found at ${this.localCoverPath}.`, e.message);
                        this.localCoverPath = ''; // Invalidate the path
                        reject(e);
                    }
                });

                writer.on('error', (err) => {
                    console.error('[COVER] ERROR: A stream error occurred during download.', err.message);
                    this.localCoverPath = ''; // Invalidate the path
                    fs.unlink(this.localCoverPath, () => {}); // Clean up empty file
                    reject(err);
                });
            });
        } catch (error) {
            console.error(`[COVER] ERROR: Failed to download cover image.`, error.message);
            this.localCoverPath = ''; // Invalidate the path on error
        }
    }

    async getChapterList(pageUrl = null) {
        // ... unchanged ...
    }

    async getChapterContent(chapterUrl) {
        // ... unchanged ...
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
                // No cover here yet, we add it conditionally
                content: [
                    // ... content
                ]
            };

            // *** CONDITIONAL COVER HANDLING ***
            if (this.localCoverPath && fs.existsSync(this.localCoverPath)) {
                console.log(`[EPUB] Attaching cover from verified path: ${this.localCoverPath}`);
                options.cover = this.localCoverPath;
            } else {
                console.log(`[EPUB] No valid local cover found. Proceeding to generate EPUB without a cover.`);
            }

            // Generate EPUB
            await new Epub(options, outputPath).promise;
            console.log(`[EPUB] EPUB generated at: ${outputPath}`);

        } catch (err) {
            console.error('[EPUB] Failed to generate EPUB:', err);
            throw err;
        }
    }

    async crawl() {
        await this.getNovelInfo();
        console.log(`Retrieved info for: ${this.novelInfo.title}`);
        
        await this.downloadCover(); // This now contains robust checks
        
        await this.getChapterList();
        console.log(`Found ${this.novelInfo.chapters.length} chapters`);
        
        for (let i = 0; i < this.novelInfo.chapters.length; i++) {
            const chapter = this.novelInfo.chapters[i];
            process.stdout.write(`Fetching ${i+1}/${this.novelInfo.chapters.length}\r`);
            
            try {
                const content = await this.getChapterContent(chapter.url);
                chapter.content = content.content;
                await new Promise(resolve => setTimeout(resolve, 1000));
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
