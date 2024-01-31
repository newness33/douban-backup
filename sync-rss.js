const {config} = require('dotenv');
const {Client} = require("@notionhq/client");
const dayjs = require('dayjs');
const got = require('got');
const jsdom = require("jsdom");
const {JSDOM} = jsdom;
const Parser = require('rss-parser');
const parser = new Parser();
const {DB_PROPERTIES, PropertyType, sleep} = require('./util');

config();

const RATING_TEXT = {
    '很差': 1,
    '较差': 2,
    '还行': 3,
    '推荐': 4,
    '力荐': 5,
};
const done = /^(看过|听过|读过|玩过)/;
const CATEGORY = {
    movie: 'movie',
    music: 'music',
    book: 'book',
    game: 'game',
    drama: 'drama',
};
const EMOJI = {
    movie: '🎞',
    music: '🎶',
    book: '📖',
    game: '🕹',
    drama: '💃🏻',
};

const DOUBAN_USER_ID = process.env.DOUBAN_USER_ID;
const notion = new Client({
    auth: process.env.NOTION_TOKEN,
});
const movieDBID = process.env.NOTION_MOVIE_DATABASE_ID;
const musicDBID = process.env.NOTION_MUSIC_DATABASE_ID;
const bookDBID = process.env.NOTION_BOOK_DATABASE_ID;
const gameDBID = process.env.NOTION_GAME_DATABASE_ID;
const dramaDBID = process.env.NOTION_DRAMA_DATABASE_ID;

(async () => {
    console.log('Refreshing feeds from RSS...');
    let feed;
    try {
        feed = await parser.parseURL(`https://www.douban.com/feed/people/${DOUBAN_USER_ID}/interests`);
    } catch (error) {
        console.error('Failed to parse RSS url: ', error);
        process.exit(1);
    }

    let feedData = {};

    // feed = feed.items.filter(item => done.test(item.title)); // care for done status items only for now
    feed = feed.items // care for done status items only for now
    feed.forEach(item => {
        const {category, id} = getCategoryAndId(item.title, item.link);
        const dom = new JSDOM(item.content.trim());
        const contents = [...dom.window.document.querySelectorAll('td p')];
        let rating = contents.filter(el => el.textContent.startsWith('推荐'));
        if (rating.length) {
            rating = rating[0].textContent.replace(/^推荐: /, '').trim();
            rating = RATING_TEXT[rating];
        }
        let comment = contents.filter(el => el.textContent.startsWith('备注'));
        if (comment.length) {
            comment = comment[0].textContent.replace(/^备注: /, '').trim();
        }
        let status;
        if (item.title.startsWith("想看")) {
            status = ["想看"]
        }
        if (item.title.startsWith("在看")) {
            status = ["在看"]
        }
        if (item.title.startsWith("看过")) {
            status = ["看过"]
        }
        if (item.title.startsWith("想读")) {
            status = ["想读"]
        }
        if (item.title.startsWith("最近在读")) {
            status = ["在读"]
        }
        if (item.title.startsWith("读过")) {
            status = ["读过"]
        }

        const result = {
            id,
            link: item.link,
            rating: typeof rating === 'number' ? rating : null,
            comment: typeof comment === 'string' ? comment : null, // 备注：XXX -> 短评
            time: item.isoDate, // '2021-05-30T06:49:34.000Z'
            status: status,
        };
        if (!feedData[category]) {
            feedData[category] = [];
        }
        feedData[category].push(result);
    });

    if (feed.length === 0) {
        console.log('No new items.');
        return;
    }

    const categoryKeys = Object.keys(feedData);
    if (categoryKeys.length) {
        for (const cateKey of categoryKeys) {
            try {
                await handleFeed(feedData[cateKey], cateKey);
            } catch (error) {
                console.error(`Failed to handle ${cateKey} feed. `, error);
                process.exit(1);
            }
        }
    }

    console.log('All feeds are handled.');
})();

async function handleFeed(feed, category) {
    if (feed.length === 0) {
        console.log(`No new ${category} feeds.`);
        return;
    }
    const dbID = getDBID(category);
    if (!dbID) {
        console.log(`No notion database id for ${category}`);
        return;
    }

    console.log(`Handling ${category} feeds...`);
    // query current db to check whether already inserted
    let filtered;
    try {
        filtered = await notion.databases.query({
            database_id: dbID,
            filter: {
                or: feed.map(item => ({
                    property: DB_PROPERTIES.ITEM_LINK,
                    url: {
                        contains: item.id,
                        // use id to check whether an item is already inserted, better than url
                        // as url may be http/https, ending with or withour /
                    },
                })),
            },
        });
    } catch (error) {
        console.error(`Failed to query ${category} database to check already inserted items. `, error);
        process.exit(1);
    }
    let update_feed = feed
    let updateMap = new Map()
    if (filtered.results.length) {
        feed = feed.filter(item => {
            let findItem = filtered.results.filter(i => i.properties[DB_PROPERTIES.ITEM_LINK].url === item.link);
            return !findItem.length; // if length != 0 means can find item in the filtered results, means this item already in db
        });
        update_feed.forEach(item => {
            let findItem = filtered.results.filter(i => i.properties[DB_PROPERTIES.ITEM_LINK].url === item.link);
            if (findItem && findItem.length) {
                for (const t of findItem) {
                    updateMap.set(t.id, item)
                }
            }
        });
    }


    console.log(`There are total ${feed.length} new ${category} item(s) need to insert.`);

    for (let i = 0; i < feed.length; i++) {
        const item = feed[i];
        const link = item.link;
        let itemData;
        try {
            itemData = await fetchItem(link, category);
            itemData[DB_PROPERTIES.ITEM_LINK] = link;
            itemData[DB_PROPERTIES.RATING] = item.rating;
            itemData[DB_PROPERTIES.RATING_DATE] = dayjs(item.time).format('YYYY-MM-DD');
            itemData[DB_PROPERTIES.COMMENTS] = item.comment;
            itemData[DB_PROPERTIES.STATUS] = item.status;
        } catch (error) {
            console.error(link, error);
        }

        if (itemData) {
            await addToNotion(itemData, category);
            await sleep(1000);
        }
    }

    for (let entry of updateMap.entries()) {
        let key = entry[0];
        let item = entry[1];
        const link = item.link;
        let itemData;
        try {
            itemData = await fetchItem(link, category);
            itemData[DB_PROPERTIES.ITEM_LINK] = link;
            itemData[DB_PROPERTIES.RATING] = item.rating;
            itemData[DB_PROPERTIES.RATING_DATE] = dayjs(item.time).format('YYYY-MM-DD');
            itemData[DB_PROPERTIES.COMMENTS] = item.comment;
            itemData[DB_PROPERTIES.STATUS] = item.status;
        } catch (error) {
            console.error(link, error);
        }

        if (itemData) {
            await updateToNotion(key, itemData, category);
            await sleep(1000);
        }
    }
    for (let i = 0; i < updateMap.length; i++) {
        const item = update_feed[i];
        const link = item.link;
        let itemData;
        try {
            itemData = await fetchItem(link, category);
            itemData[DB_PROPERTIES.ITEM_LINK] = link;
            itemData[DB_PROPERTIES.RATING] = item.rating;
            itemData[DB_PROPERTIES.RATING_DATE] = dayjs(item.time).format('YYYY-MM-DD');
            itemData[DB_PROPERTIES.COMMENTS] = item.comment;
        } catch (error) {
            console.error(link, error);
        }

        if (itemData) {
            await addToNotion(itemData, category);
            await sleep(1000);
        }
    }
    console.log(`${category} feeds done.`);
    console.log('====================');
}

function getCategoryAndId(title, link) {
    let res, id;
    if (link.indexOf("movie") > -1) {


        if (link.startsWith('http://movie.douban.com/')) {
            res = CATEGORY.movie; // "看过" maybe 舞台剧
            id = link.match(/movie\.douban\.com\/subject\/(\d+)\/?/);
            id = id[1]; // string
        } else {
            res = CATEGORY.drama; // 舞台剧
            id = link.match(/www\.douban\.com\/location\/drama\/(\d+)\/?/);
            id = id[1]; // string
        }
    }
    if (link.indexOf("book") > -1) {


        res = CATEGORY.book;
        id = link.match(/book\.douban\.com\/subject\/(\d+)\/?/);
        id = id[1]; // string
    }
    if (link.indexOf("music") > -1) {

        res = CATEGORY.music;
        id = link.match(/music\.douban\.com\/subject\/(\d+)\/?/);
        id = id[1]; // string
    }

    if (link.indexOf("game") > -1) {

        res = CATEGORY.game;
        id = link.match(/www\.douban\.com\/game\/(\d+)\/?/);
        id = id[1]; // string
    }

    return {category: res, id};
}


function getDBID(category) {
    let id;
    switch (category) {
        case CATEGORY.movie:
            id = movieDBID;
            break;
        case CATEGORY.music:
            id = musicDBID;
            break;
        case CATEGORY.book:
            id = bookDBID;
            break;
        case CATEGORY.game:
            id = gameDBID;
            break;
        case CATEGORY.drama:
            id = dramaDBID;
            break;
        default:
            break;
    }
    return id;
}

async function fetchItem(link, category) {
    console.log(`Fetching ${category} item with link: ${link}`);
    const itemData = {};
    const response = await got(link);
    const dom = new JSDOM(response.body);
    const url = require('url');

// 定义目标URL
    const targetURL = link;
    // 解析URL
    // 使用正则表达式提取ID和类型（适配不同的URL格式）
    const gameRegex = /\/game\/(\d+)\//;
    const bookRegex = /\/subject\/(\d+)\//;
    const movieRegex = /\/subject\/(\d+)\//;
    const parsedUrl = url.parse(targetURL);

    // 获取路径部分
    const path = parsedUrl.pathname;

    // 使用正则表达式匹配类型和ID
    let type = "";
    let id = "";

    if (path.match(gameRegex)) {
        type = "game";
        id = path.match(gameRegex)[1];
    } else if (path.match(bookRegex)) {
        type = "book";
        id = path.match(bookRegex)[1];
    } else if (path.match(movieRegex)) {
        type = "movie";
        id = path.match(movieRegex)[1];
    } else {
        console.error('无法从URL中提取ID或类型。URL:', targetURL);
        return;
    }

    console.log('URL:', targetURL);
    console.log('类型:', type);
    console.log('ID:', id);

    // movie item page
    if (category === CATEGORY.movie) {
        itemData[DB_PROPERTIES.TITLE] = dom.window.document.querySelector('#content h1 [property="v:itemreviewed"]').textContent.trim();
        itemData[DB_PROPERTIES.YEAR] = dom.window.document.querySelector('#content h1 .year').textContent.slice(1, -1);
        // itemData[DB_PROPERTIES.POSTER] = dom.window.document.querySelector('#mainpic img')?.src.replace(/\.webp$/, '.jpg').replace("/s_ratio_poster/", "/l/");
        itemData[DB_PROPERTIES.POSTER] = `https://dou.img.lithub.cc/${category}/${id}.jpg`;
        itemData[DB_PROPERTIES.DIRECTORS] = dom.window.document.querySelector('#info .attrs').textContent;
        itemData[DB_PROPERTIES.ACTORS] = [...dom.window.document.querySelectorAll('#info .actor .attrs a')].slice(0, 5).map(i => i.textContent).join(' / ');
        itemData[DB_PROPERTIES.GENRE] = [...dom.window.document.querySelectorAll('#info [property="v:genre"]')].map(i => i.textContent); // array
        let json_data
        try {
            json_data = JSON.parse(dom.window.document.querySelector('script[type="application/ld+json"]').textContent.replaceAll("\n", ""))
        } catch (e) {
            console.log(e)
        }
        let info = [...dom.window.document.querySelectorAll('#info span.pl')];
        let location = info.filter(i => i.textContent.trim().startsWith('制片国家'));
        itemData[DB_PROPERTIES.LOCATION] = location[0].nextSibling.textContent.trim()
        itemData[DB_PROPERTIES.PUBLISH_DATE] = dayjs(json_data['datePublished']).format('YYYY-MM-DD');
        if (json_data['@type'].indexOf("TV") > -1) {
            itemData[DB_PROPERTIES.TYPE] = ["电视剧"]
        }
        if (json_data['@type'].indexOf("Movie") > -1) {
            itemData[DB_PROPERTIES.TYPE] = ["电影"]
        }
        itemData[DB_PROPERTIES.DESCRIPTION] = dom.window.document.querySelector('meta[property="og:description"]').content
        const imdbInfo = [...dom.window.document.querySelectorAll('#info span.pl')].filter(i => i.textContent.startsWith('IMDb'));
        if (imdbInfo.length) {
            itemData[DB_PROPERTIES.IMDB_LINK] = 'https://www.imdb.com/title/' + imdbInfo[0].nextSibling.textContent.trim();
        }

        // music item page
    } else if (category === CATEGORY.music) {
        itemData[DB_PROPERTIES.TITLE] = dom.window.document.querySelector('#wrapper h1 span').textContent.trim();
        itemData[DB_PROPERTIES.POSTER] = dom.window.document.querySelector('#mainpic img')?.src.replace(/\.webp$/, '.jpg');
        let info = [...dom.window.document.querySelectorAll('#info span.pl')];
        let release = info.filter(i => i.textContent.trim().startsWith('发行时间'));
        if (release.length) {
            let date = release[0].nextSibling.textContent.trim(); // 2021-05-31, or 2021-4-2
            itemData[DB_PROPERTIES.RELEASE_DATE] = dayjs(date).format('YYYY-MM-DD');
        }
        let musician = info.filter(i => i.textContent.trim().startsWith('表演者'));
        if (musician.length) {
            itemData[DB_PROPERTIES.MUSICIAN] = musician[0].textContent.replace('表演者:', '').trim().split('\n').map(v => v.trim()).join('');
            // split and trim to remove extra spaces, rich_text length limited to 2000
        }

        // book item page
    } else if (category === CATEGORY.book) {
        itemData[DB_PROPERTIES.TITLE] = dom.window.document.querySelector('#wrapper h1 [property="v:itemreviewed"]').textContent.trim();
        // itemData[DB_PROPERTIES.POSTER] = dom.window.document.querySelector('#mainpic img')?.src.replace(/\.webp$/, '.jpg').replace("/s/", "/l/");
        // itemData[DB_PROPERTIES.POSTER] = `https://dou.img.lithub.cc/${category}/${id}.jpg`;
        itemData[DB_PROPERTIES.POSTER] = `https://raw.githubusercontent.com/newness33/douban-backup/main/images/douban/${id}.jpg`;
        let info = [...dom.window.document.querySelectorAll('#info span.pl')];
        if (dom.window.document.querySelectorAll('div[class="related_info"] h2')[0].textContent && dom.window.document.querySelectorAll('div[class="related_info"] h2')[0].textContent.trim().startsWith("内容简介")) {

            let content_desc = '';
            let pages = [dom.window.document.querySelectorAll('div[class="related_info"] h2')[0].nextElementSibling.querySelectorAll('p')][0]
            if (dom.window.document.querySelectorAll('div[class="related_info"] h2')[0].nextElementSibling.getElementsByClassName("all hidden").length > 0) {
                pages = dom.window.document.querySelectorAll('div[class="related_info"] h2')[0].nextElementSibling.getElementsByClassName("all hidden")[0].getElementsByTagName("p")
            }
            for (let page of pages) {
                content_desc += page.textContent + '\n';
            }
            itemData[DB_PROPERTIES.BOOK_DESC] = content_desc
        }
        if (dom.window.document.querySelectorAll('div[class="related_info"] h2')[1].textContent && dom.window.document.querySelectorAll('div[class="related_info"] h2')[1].textContent.trim().startsWith("作者简介")) {
            let book_desc = '';
            let pages = [dom.window.document.querySelectorAll('div[class="related_info"] h2')[1].nextElementSibling.querySelectorAll('p')][0]
            if (dom.window.document.querySelectorAll('div[class="related_info"] h2')[1].nextElementSibling.getElementsByClassName("all hidden").length > 0) {
                pages = dom.window.document.querySelectorAll('div[class="related_info"] h2')[1].nextElementSibling.getElementsByClassName("all hidden")[0].getElementsByTagName("p")
            }
            for (let page of pages) {
                book_desc += page.textContent + '\n';
            }
            itemData[DB_PROPERTIES.AUTHOR_DESC] = book_desc
        }
        info.forEach(i => {
            let text = i.textContent.trim();
            let nextText = i.nextSibling?.textContent.trim();
            if (text.startsWith('作者')) {
                let parent = i.parentElement;
                if (parent.id === 'info') { // if only one writer, then parentElement is the #info container
                    itemData[DB_PROPERTIES.WRITER] = i.nextElementSibling.textContent.replace(/\n/g, '').replace(/\s/g, '');
                } else { // if multiple writers, there will be a separate <span> element
                    itemData[DB_PROPERTIES.WRITER] = i.parentElement.textContent.trim().replace('作者:', '').trim();
                }
            } else if (text.startsWith('出版社')) {
                itemData[DB_PROPERTIES.PUBLISHING_HOUSE] = i.nextSibling.nextSibling.textContent.trim();
            } else if (text.startsWith('原作名')) {
                itemData[DB_PROPERTIES.ORIGIN_NAME] = nextText;
            } else if (text.startsWith('译者')) {
                itemData[DB_PROPERTIES.TRANSLATOR] = i.nextSibling.nextSibling.textContent.trim();
            } else if (text.startsWith('出版年')) {
                if (/年|月|日/.test(nextText)) {
                    nextText = nextText.replace(/年|月|日/g, '-').slice(0, -1); // '2000年5月' special case
                }
                itemData[DB_PROPERTIES.PUBLICATION_DATE] = dayjs(nextText).format('YYYY-MM-DD'); // this can have only year, month, but need to format to YYYY-MM-DD
            } else if (text.startsWith('ISBN')) {
                itemData[DB_PROPERTIES.ISBN] = Number(nextText);
            }
        });

        // game item page
    } else if (category === CATEGORY.game) {
        itemData[DB_PROPERTIES.TITLE] = dom.window.document.querySelector('#wrapper #content h1').textContent.trim();
        // itemData[DB_PROPERTIES.POSTER] = dom.window.document.querySelector('.item-subject-info .pic img')?.src.replace(/\.webp$/, '.jpg');
        itemData[DB_PROPERTIES.POSTER] = `https://dou.img.lithub.cc/${category}/${id}.jpg`;
        const gameInfo = dom.window.document.querySelector('#content .game-attr');
        const dts = [...gameInfo.querySelectorAll('dt')].filter(i => i.textContent.startsWith('类型') || i.textContent.startsWith('发行日期'));
        if (dts.length) {
            dts.forEach(dt => {
                if (dt.textContent.startsWith('类型')) {
                    itemData[DB_PROPERTIES.GENRE] = [...dt.nextElementSibling.querySelectorAll('a')].map(a => a.textContent.trim()); //array
                } else if (dt.textContent.startsWith('发行日期')) {
                    let date = dt.nextElementSibling.textContent.trim();
                    itemData[DB_PROPERTIES.RELEASE_DATE] = dayjs(date).format('YYYY-MM-DD');
                }
            })
        }

        // drama item page
    } else if (category === CATEGORY.drama) {
        itemData[DB_PROPERTIES.TITLE] = dom.window.document.querySelector('#content .drama-info .meta h1').textContent.trim();
        let genre = dom.window.document.querySelector('#content .drama-info .meta [itemprop="genre"]').textContent.trim();
        itemData[DB_PROPERTIES.GENRE] = [genre];
        itemData[DB_PROPERTIES.POSTER] = dom.window.document.querySelector('.drama-info .pic img')?.src.replace(/\.webp$/, '.jpg');
    }

    return itemData;
}

function getPropertyValye(value, type, key) {
    let res = null;
    switch (type) {
        case 'title':
            res = {
                title: [
                    {
                        text: {
                            content: value,
                        },
                    },
                ],
            };
            break;
        case 'file':
            res = {
                files: [
                    {
                        // file: {}
                        name: value,
                        external: { // need external:{} format to insert the files property, but still not successful
                            url: value,
                        },
                    },
                ],
            };
            break;
        case 'date':
            res = {
                date: {
                    start: value,
                },
            };
            break;
        case 'multi_select':
            res = key === DB_PROPERTIES.RATING ? {
                'multi_select': value ? [
                    {
                        name: value.toString(),
                    },
                ] : [],
            } : {
                'multi_select': (value || []).map(g => ({
                    name: g, // @Q: if the option is not created before, can not use it directly here?
                })),
            };
            break;
        case 'rich_text':
            res = {
                'rich_text': [
                    {
                        type: 'text',
                        text: {
                            content: value || '',
                        },
                    },
                ],
            }
            break;
        case 'number':
            res = {
                number: value ? Number(value) : null,
            };
            break;
        case 'url':
            res = {
                url: value || url,
            };
            break;
        default:
            break;
    }

    return res;
}

async function addToNotion(itemData, category) {
    console.log('Going to insert ', itemData[DB_PROPERTIES.RATING_DATE], itemData[DB_PROPERTIES.TITLE]);
    try {
        // @TODO: refactor this to add property value generator by value type
        let properties = {};
        const keys = Object.keys(DB_PROPERTIES);
        keys.forEach(key => {
            if (itemData[DB_PROPERTIES[key]]) {
                properties[DB_PROPERTIES[key]] = getPropertyValye(itemData[DB_PROPERTIES[key]], PropertyType[key], DB_PROPERTIES[key]);
            }
        });

        const dbid = getDBID(category);
        if (!dbid) {
            throw new Error('No databse id found for category: ' + category);
        }
        const db = await notion.databases.retrieve({database_id: dbid});
        const columns = Object.keys(db.properties);
        // remove cols which are not in the current database
        const propKeys = Object.keys(properties);
        propKeys.map(prop => {
            if (columns.indexOf(prop) < 0) {
                delete properties[prop];
            }
        });

        const postData = {
            parent: {
                database_id: dbid,
            },
            icon: {
                type: 'emoji',
                emoji: EMOJI[category],
            },
            // fill in properties by the format: https://developers.notion.com/reference/page#page-property-value
            properties,
        };
        if (properties[DB_PROPERTIES.POSTER]) {
            // use poster for the page cover
            postData.cover = {
                type: 'external',
                external: {
                    url: properties[DB_PROPERTIES.POSTER]?.files[0]?.external?.url, // cannot be empty string or null
                },
            }
        }
        const response = await notion.pages.create(postData);
        if (response && response.id) {
            console.log(itemData[DB_PROPERTIES.TITLE] + `[${itemData[DB_PROPERTIES.ITEM_LINK]}]` + ' page created.');
        }
    } catch (error) {
        console.warn('Failed to create ' + itemData[DB_PROPERTIES.TITLE] + `(${itemData[DB_PROPERTIES.ITEM_LINK]})` + ' with error: ', error);
    }
}

async function updateToNotion(key, itemData, category) {
    console.log('Going to update ', itemData[DB_PROPERTIES.RATING_DATE], itemData[DB_PROPERTIES.TITLE]);
    try {
        // @TODO: refactor this to add property value generator by value type
        let properties = {};
        const keys = Object.keys(DB_PROPERTIES);
        keys.forEach(key => {
            if (itemData[DB_PROPERTIES[key]]) {
                properties[DB_PROPERTIES[key]] = getPropertyValye(itemData[DB_PROPERTIES[key]], PropertyType[key], DB_PROPERTIES[key]);
            }
        });

        const dbid = getDBID(category);
        if (!dbid) {
            throw new Error('No databse id found for category: ' + category);
        }
        const db = await notion.databases.retrieve({database_id: dbid});
        const columns = Object.keys(db.properties);
        // remove cols which are not in the current database
        const propKeys = Object.keys(properties);
        propKeys.map(prop => {
            if (columns.indexOf(prop) < 0) {
                delete properties[prop];
            }
        });

        const postData = {
            parent: {
                database_id: dbid,
            },
            icon: {
                type: 'emoji',
                emoji: EMOJI[category],
            },
            // fill in properties by the format: https://developers.notion.com/reference/page#page-property-value
            properties,
        };
        if (properties[DB_PROPERTIES.POSTER]) {
            // use poster for the page cover
            postData.cover = {
                type: 'external',
                external: {
                    url: properties[DB_PROPERTIES.POSTER]?.files[0]?.external?.url, // cannot be empty string or null
                },
            }
        }
        postData.page_id = key
        const response = await notion.pages.update(postData);
        if (response && response.id) {
            console.log(itemData[DB_PROPERTIES.TITLE] + `[${itemData[DB_PROPERTIES.ITEM_LINK]}]` + ' page update.');
        }
    } catch (error) {
        console.warn('Failed to update ' + itemData[DB_PROPERTIES.TITLE] + `(${itemData[DB_PROPERTIES.ITEM_LINK]})` + ' with error: ', error);
    }
}

