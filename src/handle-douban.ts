import got from 'got';
import {JSDOM} from 'jsdom';
import dayjs from 'dayjs';
import {consola} from 'consola';
import {ItemCategory} from './types';
import DB_PROPERTIES from '../cols.json';

const ImgSelector = '#mainpic img';
const ImgDefaultTitle = {
    Poster: '点击看更多海报',
    Cover: '点击上传封面图片',
};
const InfoSelector = '#info span.pl';

export default async function scrapyDouban(link: string, category: ItemCategory): Promise<{
    [key: string]: string | string[] | number | null | undefined;
}> {
    consola.start(`Scraping ${category} item with link: ${link}`);
    const response = await got(link);
    const dom = new JSDOM(response.body);
    const doc = dom.window.document;

    switch (category) {
        case ItemCategory.Movie:
            return buildMovieItem(doc);
        case ItemCategory.Music:
            return buildMusicItem(doc);
        case ItemCategory.Book:
            return buildBookItem(doc);
        case ItemCategory.Game:
            return buildGameItem(doc);
        case ItemCategory.Drama:
            return buildDramaItem(doc);
        default:
            return {}
    }
}

function buildMovieItem(doc: Document) {
    const title = doc.querySelector('#content h1 [property="v:itemreviewed"]')?.textContent?.trim() || '';
    const year = doc.querySelector('#content h1 .year')?.textContent?.slice(1, -1) || '';
    const img = doc.querySelector(ImgSelector) as HTMLImageElement;
    const poster = img?.title === ImgDefaultTitle.Poster ? img?.src?.trim().replace(/\.webp$/, '.jpg') : '';
    // const poster = img?.title === ImgDefaultTitle.Poster ? img?.src?.trim().replace(/\.webp$/, '.jpg').replace("s_ratio_poster", "m") : '';

    const infoPl = [...doc.querySelectorAll(InfoSelector)];
    const directorPl = infoPl.filter(i => i.textContent === '导演');
    const directors = (directorPl.length ? directorPl[0] : infoPl[0]).nextElementSibling?.textContent?.trim() || '';
    const actorsPl = infoPl.filter(i => i.textContent === '主演');
    const actors = actorsPl.length
        ? [...actorsPl[0].nextElementSibling?.querySelectorAll('span a')!]
            .slice(0, 5).map(i => i.textContent).join(' / ')
        : '';
    const production = infoPl.filter(i => i.textContent.indexOf("制片国家/地区") > -1)[0].nextSibling?.textContent?.trim() || '';
// 新增 JSON-LD 解析

    // ... existing code ...
    const jsonLd = doc.querySelector('script[type="application/ld+json"]')?.textContent;
    // 清洗JSON中的非法控制字符
    const cleanedJson = jsonLd?.replace(/[\u0000-\u001F]/g, '') || '';  // 移除所有控制字符
    let datePublished = ''
    try {
        datePublished = cleanedJson ? JSON.parse(cleanedJson)?.datePublished?.slice(0, 10) : '';
    } catch (e) {
        consola.error(e)
    }
// ... existing code ...
    const writersPl = infoPl.filter(i => i.textContent === '编剧');
    const writers = writersPl.length
        ? [...writersPl[0].nextElementSibling?.querySelectorAll('span a')!]
            .slice(0, 5).map(i => i.textContent).join(' / ')
        : '';
    console.log('writers: ', writers);
    const genre = [...doc.querySelectorAll('#info [property="v:genre"]')].map(i => i.textContent || '').filter(v => v);
    const imdbInfo = [...doc.querySelectorAll(InfoSelector)].filter(i => i.textContent?.startsWith('IMDb'));
    const imdbLink = imdbInfo.length ? 'https://www.imdb.com/title/' + imdbInfo[0].nextSibling?.textContent?.trim() : '';
    // 新增电视剧判断逻辑
    const episodeCount = infoPl.filter(i => i.textContent.indexOf("集数") > -1)[0]?.nextSibling?.textContent?.trim();
    const episodeRuntime = infoPl.filter(i => i.textContent.indexOf("单集片长") > -1)[0]?.nextSibling?.textContent?.trim();
    const isTVSeries = !!episodeCount || !!episodeRuntime;
    const synopsis = doc.querySelector('#link-report-intra span[property="v:summary"]')?.textContent?.trim() || '';

    const item = {
        [DB_PROPERTIES.NAME]: title,
        [DB_PROPERTIES.TITLE]: `${title} (${year})`,
        [DB_PROPERTIES.MOVIE_TITLE]: title,
        [DB_PROPERTIES.YEAR]: year,
        [DB_PROPERTIES.POSTER]: poster, // optional
        [DB_PROPERTIES.DIRECTORS]: directors,
        [DB_PROPERTIES.SCREENWRITERS]: writers, // optional
        [DB_PROPERTIES.ACTORS]: actors,
        [DB_PROPERTIES.GENRE]: genre,
        [DB_PROPERTIES.IMDB_LINK]: imdbLink,
        [DB_PROPERTIES.PRODUCTION]: production,
        [DB_PROPERTIES.MEDIA_TYPE]: isTVSeries ? '电视剧' : '电影',
        [DB_PROPERTIES.SYNOPSIS]: synopsis?.slice(0, 2000),
        [DB_PROPERTIES.publishDatetime]: datePublished,
    };
    return item;
}

function buildMusicItem(doc: Document) {
    const title = doc.querySelector('#wrapper h1 span')?.textContent?.trim() || '';
    const img = doc.querySelector(ImgSelector) as HTMLImageElement;
    const cover = img?.title !== ImgDefaultTitle.Cover && img?.src.length <= 100 ? img?.src.replace(/\.webp$/, '.jpg') : '';
    const info = [...doc.querySelectorAll(InfoSelector)];
    const release = info.filter(i => i.textContent?.trim().startsWith('发行时间'));
    const releaseDate = release.length ? dayjs(release[0].nextSibling?.textContent?.trim()).format('YYYY-MM-DD') : '';
    const musicianElems = info.filter((i) => i.textContent?.trim().startsWith('表演者'));
    // split and trim to remove extra spaces, rich_text length limited to 2000
    const musician = musicianElems.length
        ? musicianElems[0].textContent?.replace('表演者:', '').trim()
            .split('\n').map((v) => v.trim()).join('')
        : '';

    return {
        [DB_PROPERTIES.MUSIC_TITLE]: title,
        [DB_PROPERTIES.NAME]: title,
        [DB_PROPERTIES.COVER]: cover, // optional
        [DB_PROPERTIES.RELEASE_DATE]: releaseDate, // optional
        [DB_PROPERTIES.MUSICIAN]: musician, // optional
    };
}

function buildBookItem(doc: Document) {
    const title = doc.querySelector('#wrapper h1 [property="v:itemreviewed"]')?.textContent?.trim() || '';
    const img = doc.querySelector(ImgSelector) as HTMLImageElement;
    const cover = img?.title !== ImgDefaultTitle.Cover && img?.src.length <= 100 ? img?.src.replace(/\.webp$/, '.jpg') : '';
    const info = [...doc.querySelectorAll(InfoSelector)];

    let writer = '', publisher = '', bookTitle = title, publishDate = '', isbn = 0, translator = '', originalTitle = '';
    info.forEach(i => {
        const text = i.textContent?.trim() || '';
        // nextSibling 也可能是个空的 #text node
        let nextText = i.nextSibling?.textContent?.trim() || i.nextElementSibling?.textContent?.trim() || '';

        if (text.startsWith('作者')) {
            writer = i.parentElement?.id === 'info'
                // if only one writer, then parentElement is the #info container
                ? i.nextElementSibling?.textContent?.replace(/\n/g, '').replace(/\s/g, '') || ''
                // if multiple writers, there will be a separate <span> element
                : i.parentElement?.textContent?.trim().replace('作者:', '').trim() || '';

        } else if (text.startsWith('出版社')) {
            // nextSibling 也可能是个空的 #text node，则需要跳过
            publisher = (i.nextElementSibling?.tagName === 'BR' || !i.nextSibling?.textContent?.trim())
                ? nextText
                // 出版社可能有单独链接 <a>上海三联书店</a>
                : i.parentElement?.textContent?.trim() || '';

        } else if (text.startsWith('原作名')) {
            bookTitle = title;
            originalTitle = nextText
        } else if (text.startsWith('出版年')) {
            if (/年|月|日/.test(nextText)) {
                nextText = nextText.replace(/年|月|日/g, '-').slice(0, -1); // '2000年5月' special case
            }
            publishDate = dayjs(nextText).format('YYYY-MM-DD');

        } else if (text.startsWith('ISBN')) {
            isbn = Number(nextText);
        } else if (text.startsWith('译者')) {
            translator = i.nextElementSibling.textContent?.trim() || '';
        }
    });
    let description = ''
    let author_description = ''
    try {
        const intros = [...doc.querySelectorAll("div.related_info div.intro")]
        if (intros[1].textContent?.trim().length > intros[0].textContent?.trim().length) {
            description = intros[1]?.textContent?.trim()?.slice(0, 2000)
        } else description = intros[0]?.textContent?.trim()?.slice(0, 2000)
        author_description = doc.querySelector('#content > div > div.article > div.related_info > div:nth-child(8) > div > div').textContent?.trim()?.slice(0, 2000)
    } catch (e) {
        console.error('error: ',e)
    }
    return {
        [DB_PROPERTIES.NAME]: title,
        [DB_PROPERTIES.COVER]: cover,
        [DB_PROPERTIES.POSTER]: cover,// optional
        [DB_PROPERTIES.WRITER]: writer, // optional
        [DB_PROPERTIES.PUBLISHING_HOUSE]: publisher, // optional
        [DB_PROPERTIES.BOOK_TITLE]: bookTitle, // optional
        [DB_PROPERTIES.TITLE]: bookTitle,
        [DB_PROPERTIES.PUBLICATION_DATE]: publishDate, // optional
        [DB_PROPERTIES.ISBN]: isbn, // optional
        [DB_PROPERTIES.BOOK_DESCRIPTION]: description,
        [DB_PROPERTIES.AUTHOR_DESC]: author_description,
        [DB_PROPERTIES.TRANSLATOR]: translator,
        [DB_PROPERTIES.ORIGINAL_TITLE]: originalTitle,
    };
}

function buildGameItem(doc: Document) {
    const title = doc.querySelector('#wrapper #content h1')?.textContent?.trim() || '';
    const img = doc.querySelector('.item-subject-info .pic img') as HTMLImageElement;
    const cover = img?.title !== ImgDefaultTitle.Cover && img?.src.length <= 100 ? img?.src.replace(/\.webp$/, '.jpg').replace("s_ratio_poster", "m") : '';
    const gameInfo = doc.querySelector('#content .game-attr') as Element;
    const dts = [...gameInfo.querySelectorAll('dt')];
    const genre: string[] = [];
    let releaseDate = '';
    dts.forEach(dt => {
        if (dt.textContent?.startsWith('类型')) {
            const strs = [...dt.nextElementSibling!.querySelectorAll('a')].map((a) => a.textContent?.trim() || '').filter(v => v);
            genre.push(...strs);
        } else if (dt.textContent?.startsWith('发行日期')) {
            const date = dt.nextElementSibling?.textContent?.trim() || '';
            releaseDate = date ? dayjs(date).format('YYYY-MM-DD') : '';
        }
    });

    return {
        [DB_PROPERTIES.GAME_TITLE]: title,
        [DB_PROPERTIES.NAME]: title,
        [DB_PROPERTIES.COVER]: cover, // optional
        [DB_PROPERTIES.GENRE]: genre, // optional string[]
        [DB_PROPERTIES.RELEASE_DATE]: releaseDate, // optional
    }
}

function buildDramaItem(doc: Document) {
    const title = doc.querySelector('#content .drama-info .meta h1')?.textContent?.trim() || '';
    const genre = doc.querySelector('#content .drama-info .meta [itemprop="genre"]')?.textContent?.trim() || '';
    const img = doc.querySelector('.drama-info .pic img') as HTMLImageElement;
    const poster = img?.title !== ImgDefaultTitle.Cover && img?.src.length <= 100 ? img?.src.replace(/\.webp$/, '.jpg') : '';
    return {
        [DB_PROPERTIES.DRAMA_TITLE]: title,
        [DB_PROPERTIES.NAME]: title,
        [DB_PROPERTIES.POSTER]: poster, // optional
        [DB_PROPERTIES.GENRE]: genre ? [genre] : [], // optional
    };
}
