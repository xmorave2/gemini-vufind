const express = require('express');
const cors = require('cors');
const { GoogleGenAI } = require("@google/genai");
const apiKey = process.env.GEMINI_API_KEY;
const ai = new GoogleGenAI({ apiKey: apiKey });
require('dotenv').config();
const app = express();

console.log('=== SERVER STARTED ===');
console.log('Time:', new Date().toISOString());
console.log('API key found:', !!process.env.GEMINI_API_KEY);
console.log('API Key begins with:', process.env.GEMINI_API_KEY?.substring(0, 7));

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const VUFIND_API_BASE = 'https://knihovny.cz/api/v1';


// Clean up the search term by removing stop words
function cleanSearchQuery(searchTerm) {
    const stopWords = [
        'a', 'and', 'z', 'i', 'v', 'ze', 've', 'nad', 'pod'
    ];

    // Normalize the search term to lowercase and split it into words
    let words = searchTerm.toLowerCase().split(/\s+/);
    
    // Remove stop words
    words = words.filter(word => !stopWords.includes(word));

    return words.join(' ').trim();
}

// Analyse the search term using Gemini
async function analyzeSearchQuery(searchTerm) {
    try {
        const cleanedTerm = cleanSearchQuery(searchTerm);
        
        console.log('\n=== Gemini analyse start ===');
        console.log('Search phrase:', cleanedTerm);
        
        console.log('Sending to Gemini...');
        const prompt = 'You are a bibliographic metadata research system for scientific libraries. ' +
            'Analyze the search term and identify the main concepts. ' +
            'Generate ONE alternative search term that is related to term "' +
            searchTerm +
            '", uses different but semantically similar words, describes the same topic from a different perspective, and is in the same language as the input. ' +
            'Return the analysis in JSON format: { "analysis": { "potentialAuthor": "author name", "potentialTitle": "other words" }, "searchType": "known-item" or "topic", "mainSearchTerm": "original search query", "alternativeSearchTerm": "German alternative search term", "filters": [], "sort": "relevance" }';

        const response = await ai.models.generateContent({
            model: "gemini-2.0-flash",
            contents: prompt,
        });

        console.log('Prompt sent to Gemini');
        console.log('Response received from Gemini: ' + response.text);
        console.log('Trimmed response:', response.text.replaceAll('```json', '').replaceAll('```', ''));
        const analysis = JSON.parse(response.text.replace('```json', '').replaceAll('```', ''));
        return analysis;
    } catch (error) {
        console.error('\n=== Gemini search term analysis failed ===');
        console.error('Error code:', error.constructor.name);
        console.error('Error message:', error.message);
        throw error;
    }
}

app.post('/api/search', async (req, res) => {
    console.log('\n=== NEW SEARCH ===');
    console.log('Time:', new Date().toISOString());
    console.log('Request Body:', JSON.stringify(req.body, null, 2));
    console.log('========================\n');
    
    try {
        const { searchTerm, searchType, forceBasics } = req.body;
        
        if (!searchTerm) {
            return res.json({ 
                records: [], 
                resultCount: 0
            });
        }

        let searchParams = new URLSearchParams();
        searchParams.append('limit', '20');

        const standardFields = [
            'title',
            'authors',
            'formats',
            'publicationDates',
            'publishers',
            'languages',
            'summary',
            'subjects'
        ];
        
        standardFields.forEach(field => {
            searchParams.append('field[]', field);
        });

        let analysis;
        if (forceBasics) {
            analysis = {
                searchType: 'basics',
                mainSearchTerm: searchTerm,
                potentialAuthor: null,
                potentialTitle: null,
                isStandardWork: false,
                alternativeSearchTerm: null
            };
        } else {
            analysis = await analyzeSearchQuery(searchTerm);
        }

        switch(analysis.searchType) {
            case 'known-item':
                searchParams.set('type', 'AllFields');
                searchParams.set('lookfor', analysis.mainSearchTerm);
                searchParams.set('sort', 'year');
                break;

            case 'basics':
                searchParams.set('type', 'Title');
                searchParams.set('limit', '20');
                searchParams.set('sort', 'year');
                
                searchParams.append('filter[]', 'format:"Book"');
                
                const basicTerms = [
                    'Introduction', 'Handbook', 'Textbook',
                    'Basics', 'Guide', 'Manual', 'Overview', 'Review',
                ];
                
                const quotedMainTerm = `"${analysis.mainSearchTerm}"`;
                const basicTermsQuery = basicTerms.join(' OR ');
                searchParams.set('lookfor', `${quotedMainTerm}AND(${basicTermsQuery})`);
                break;

            case 'topic':
                searchParams.set('type', 'AllFields');
                let searchString = analysis.mainSearchTerm;
                if (analysis.alternativeSearchTerm) {
                    searchString += ` OR "${analysis.alternativeSearchTerm}"`;
                }
                searchParams.set('lookfor', searchString);
                searchParams.append('field[]', 'title');
                searchParams.append('field[]', 'subjects');
                break;

            default:
                searchParams.set('sort', 'relevance');
                break;
        }

        if (analysis.filters) {
            analysis.filters.forEach(filter => {
                searchParams.append('filter[]', filter);
            });
        }

        // Debug: Vufind API URL
        const searchUrl = `${VUFIND_API_BASE}/search?${searchParams.toString()}`;
        console.log('\n=== Claude-Supported Search: VuFind Suchanfrage ===');
        console.log('Search term:', searchTerm);
        console.log('Parameters:', Object.fromEntries(searchParams));
        console.log('API URL:', searchUrl);
        console.log('========================\n');

        const response = await fetch(searchUrl, {
            headers: {
                'User-Agent': 'KnihovnyCzAI/1.0',
                'Accept': 'application/json'
            }
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            console.error('API Error Status:', response.status);
            console.error('API Error Text:', errorText);
            console.error('API Error Headers:', Object.fromEntries(response.headers));
            throw new Error(`HTTP error! status: ${response.status} - ${errorText}`);
        }

        const data = await response.json();

        // Debug: Vufind API response
        console.log('\n=== Gemini-Supported Search: API Response ===');
        console.log('Number of records found:', data.resultCount);
        console.log('Status:', data.status);
        console.log('API response:', JSON.stringify(data, null, 2));
        console.log('========================\n');

        // Prüfe ob records vorhanden sind
        if (!data.records) {
            console.error('Gemini-Supported Search: No records found');
            return res.json({ records: [], resultCount: 0 });
        }

        const formattedResponse = {
            records: data.records,
            resultCount: data.resultCount,
            searchType: analysis.searchType,
            analysis: analysis.analysis || null,
            searchParams: {
                term: searchTerm,
                parameters: Object.fromEntries(searchParams),
                url: searchUrl
            },
            alternativeSearchTerm: analysis.alternativeSearchTerm
        };

        // Debug: Formatierte Antwort
        console.log('=== Formatted response ===');
        if (analysis.searchType === 'basics') {
            console.log('Analysis:', {
                searchType: 'basics',
                mainSearchTerm: analysis.mainSearchTerm
            });
        } else {
            console.log('Analysis:', {
                potentialAuthor: analysis.analysis.potentialAuthor,
                potentialTitle: analysis.analysis.potentialTitle,
                alternativeSearchTerm: analysis.alternativeSearchTerm
            });
        }
        console.log('========================\n');

        res.json(formattedResponse);

    } catch (error) {
        console.error('Search Error:', error);
        res.json({ 
            records: [],
            resultCount: 0,
            error: error.message
        });
    }
});

app.listen(3001, () => {
    console.log('Server running on port 3001');
});