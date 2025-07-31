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
            css: ".no-hyphens,h1,h2,h3,h4,h5,h6{adobe-hyphenate:none!important}blockquote p,blockquote p.first-para,dd p,h1+p,h2+p,h3+p,h4+p,h5+p,h6+p,li,li p,p.first-para,p.first-para-chapter,p.no-indent,p.note-p-first{text-indent:0}p.first-para-chapter::first-line,th{font-variant:small-caps}.group,.ingredient,h1,h2,h3,h4,h5,h6,table,td{page-break-inside:avoid}dl,ol,td,ul{text-align:left}.zebra tr:nth-child(6n+0),.zebra tr:nth-child(6n+1),.zebra tr:nth-child(6n-1),div.cover img,div.hint,div.note,div.tip,figure{background-color:#ccc}.caption,.tocEntry-1 a,dt,figure figcaption{font-weight:700}.tocEntry-1 a,.tocEntry-2 a,.tocEntry-3 a,.tocEntry-4 a{text-decoration:none;color:#000}.page-break-after,div.cover{page-break-after:always}.center,pre{display:block}a,abbr,acronym,address,applet,article,aside,audio,b,big,blockquote,body,canvas,caption,center,cite,code,dd,del,details,dfn,div,dl,dt,em,embed,fieldset,figcaption,figure,footer,form,h1,h2,h3,h4,h5,h6,header,hgroup,html,i,iframe,img,ins,kbd,label,legend,mark,menu,nav,object,output,p,pre,q,ruby,s,samp,section,small,span,strike,strong,sub,summary,sup,table,tbody,td,tfoot,th,thead,time,tr,tt,u,var,video{margin-right:0;padding:0;border:0;font-size:100%;vertical-align:baseline}td,th{padding:5px!important;vertical-align:baseline}@page{margin-top:30px;margin-bottom:20px}div.cover{text-align:center;padding:0;margin:0}div.cover img{height:100%;max-width:100%;padding:10px;margin:0}.half{max-width:50%}.tenth{max-width:10%;width:10%}.cover-img{height:100%;max-width:100%;padding:0;margin:0}.padding-only,figure{padding:1em}h1,h2,h3,h4,h5,h6{hyphens:none!important;-moz-hyphens:none!important;-webkit-hyphens:none!important;page-break-after:avoid;text-indent:0;text-align:left;font-family:Helvetica,Arial,sans-serif}li,p{font-family:Palatino,"Times New Roman",Caecilia,serif;orphans:2;widows:2;text-align:justify;margin:0;line-height:1.5em}h1{font-size:1.6em;margin-bottom:3.2em}.title h1{margin-bottom:0;margin-top:3.2em}h2{font-size:1em;margin-top:.5em;margin-bottom:.5em}h3{font-size:.625em}h4{font-size:.391em}h5{font-size:.244em}h6{font-size:.153em}.tocEntry-2 a,p{text-indent:1em}p{-webkit-hyphens:auto;-moz-hyphens:auto;hyphens:auto;hyphenate-after:3;hyphenate-before:3;hyphenate-lines:2;-webkit-hyphenate-after:3;-webkit-hyphenate-before:3;-webkit-hyphenate-lines:2}.no-hyphens{hyphens:none!important;-moz-hyphens:none!important;-webkit-hyphens:none!important}.rtl{direction:rtl;float:right}.drop,.dropcap{margin-right:.075em;float:left;height:.8em}.drop{overflow:hidden;line-height:89%;font-size:281%}.dropcap{line-height:100%;font-size:341%;margin-top:-.22em}.per100,.per60,.per70,.per80,.per90{line-height:.9em}dl,ol,ul{margin:1em 0}blockquote,pre{margin-left:1em}dt{font-family:Helvetica,Arial,sans-serif}dd{line-height:1.5em;font-family:Palatino,"Times New Roman",Caecilia,serif}blockquote{margin-right:1em;line-height:1.5em;font-style:italic}code,kbd,pre,samp,tt{font-family:"Courier New",Courier,monospace;word-wrap:break-word}pre{font-size:.8em;line-height:1.2em;margin-bottom:1em;white-space:pre-wrap}img{border-radius:.3em;-webkit-border-radius:0.3em;-webkit-box-shadow:rgba(0,0,0,.15) 0 1px 4px;box-shadow:rgba(0,0,0,.15) 0 1px 4px;box-sizing:border-box;border:.5em solid #fff;max-width:80%;max-height:80%}img.pwhack{width:100%}.caption,figure figcaption{text-align:center;font-size:.8em}p img{border-radius:0;border:none}.box-example,.dashed{border:2px dashed #ef2929}figure{border:1px solid #000;text-align:center}div.div-literal-block-admonition{margin-left:1em;background-color:#ccc}div.hint,div.note,div.tip{margin:1em 0!important;padding:1em!important;border-top:0 solid #ccc;border-bottom:0 dashed #ccc;page-break-inside:avoid}.stanza,.stanza p{padding-left:1em}.admonition-title,p.note-title{margin-top:0;font-variant:small-caps;font-size:.9em;text-align:center;font-weight:700;font-style:normal;-webkit-hyphens:none;-moz-hyphens:none;hyphens:none}.footnote,.footnote-link,.smaller{font-size:.8em}.note-p,div.note p{text-indent:1em;margin-left:0;margin-right:0}.center,td{text-indent:0}div.note p.note-p-first{text-indent:0;margin-left:0;margin-right:0}table{border-spacing:0;border:1px;margin:1em auto;border-collapse:collapse;border-spacing:0}th{border-bottom:1px solid #000}td{font-family:Palatino,"Times New Roman",Caecilia,serif;font-size:small;hyphens:none;-moz-hyphens:none;-webkit-hyphens:none}sub,sup{font-size:.5em;line-height:.5em}.footnote-link,sup{vertical-align:super}td:nth-last-child{border-bottom:1px solid #000}.zebra tr th{background-color:#fff}sub{vertical-align:sub}table.footnote{margin:.5em 0 0}.tocEntry-2 a{margin-left:1em}.tocEntry-3 a{text-indent:2em}.tocEntry-4 a{text-indent:3em}.copyright-top{margin-top:6em}.page-break-before{page-break-before:always}.center{text-align:center;margin-left:auto;margin-right:auto}.pos1,.pos2,.pos3,.pos4{text-indent:-1em}.right{text-align:right}.left{text-align:left}.f-right{float:right}.f-left,.ln{float:left}.box-example{background-color:#8ae234;margin:2em;padding:1em}.blue{background-color:#00f}.margin-only{margin:2em}.em1{font-size:.5em}.em2{font-size:.75em}.em3{font-size:1em}.em4{font-size:1.5em}.em5{font-size:2em}.per1{font-size:50%}.per2{font-size:75%}.per3{font-size:100%}.per4{font-size:150%}.per5{font-size:200%}.mousepoem p{line-height:0;margin-left:1em}.per100{font-size:100%}.per90{font-size:90%}.per80{font-size:80%}.per70{font-size:70%}.per60{font-size:60%}.per50{font-size:50%;line-height:1.05em}.per40{font-size:40%;line-height:.9em}.size1{font-size:x-small}.size2{font-size:small}.size3{font-size:medium}.size4{font-size:large}.size5{font-size:x-large}.stanza{margin-top:1em;font-family:serif}.poetry{margin:1em}.ln{color:#999;font-size:.8em;font-style:italic}.pos1{margin-left:1em}.pos2{margin-left:2em}.pos3{margin-left:3em}.pos4{margin-left:4em}@font-face{font-family:Inconsolata Mono;font-style:normal;font-weight:400;src:url("Inconsolata.otf")}.normal-mono{font-family:"Courier New",Courier,monospace}.mono,pre,tt{font-family:"Inconsolata Mono","Courier New",Courier,monospace;font-style:normal}@font-face{font-family:mgopen modata;font-style:normal;font-weight:400;font-size:.5em;src:url("MgOpenModataRegular.ttf")}.modata{font-family:"mgopen modata"}@font-face{font-family:hidden;font-style:normal;font-weight:400;font-size:1em;src:url("invisible1.ttf")}.hidden-font{font-family:hidden}@media (min-width:200px){.px200{color:#8ae234}}@media (min-width:400px){.px400{color:#8ae234}}@media (min-width:800px){.px800{color:#8ae234}}@media (min-width:1200px){.px1200{color:#8ae234}}@media amzn-kf8{span.dropcapold{font-size:300%;font-weight:700;height:1em;float:left;margin:-.2em .1em 0}.dropcap{line-height:100%;font-size:341%;margin-right:.075em;margin-top:-.22em;float:left;height:.8em}}@media amzn-mobi{pre,tt{font-family:"Courier New",Courier,monospace}.note-p,blockquote,div.note{margin-right:0;margin-left:0}span.dropcap{font-size:1.5em;font-weight:700}pre{margin-left:1em;margin-bottom:1em;font-size:x-small;white-space:pre-wrap;display:block}div.no-indent,pre .no-indent{margin-left:0;text-indent:0}h1,h3{font-size:2em}h2,h4{font-size:1em}blockquote{font-style:italics}div.note{border:1px solid #000}.note-p,div.note{text-indent:1em;font-style:italic}.note-p,.note-p-first{margin-left:1em;margin-right:1em}.note-p-first{text-indent:0}.note-p{text-indent:1em}.pos1,.pos2,.pos3,.pos4{text-indent:-1em}}.green{color:#8ae234}", // Custom CSS string
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
