const express = require('express');
const cors = require('cors');
const Anthropic = require('@anthropic-ai/sdk');
require('dotenv').config();
const app = express();

console.log('=== SERVER STARTED ===');
console.log('Server Zeit:', new Date().toISOString());
console.log('Anthropic API Key vorhanden:', !!process.env.ANTHROPIC_API_KEY);
console.log('API Key beginnt mit:', process.env.ANTHROPIC_API_KEY?.substring(0, 7));

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const VUFIND_API_BASE = 'https://hcu-testing-vufind.dev.effective-webwork.de/vufind/api/v1';

const anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY
});

// Funktion zur Bereinigung der Suchanfrage
function cleanSearchQuery(searchTerm) {
    // Liste von Wörtern, die aus der Suche entfernt werden sollen
    const stopWords = [
        'zeig', 'mir', 'ich', 'suche', 'nach', 'bitte', 'kannst', 'du',
        'finde', 'für', 'mich', 'brauche', 'ich', 'will', 'ich', 'habe',
        'ich', 'gesucht', 'suchen', 'möchte', 'ich', 'könntest', 'du',
        'würdest', 'du', 'kannst', 'du', 'bitte', 'mal', 'zeig', 'mir',
        'bitte', 'mal', 'alle', 'die', 'der', 'das', 'eine', 'ein',
        'über', 'von', 'zu', 'und', 'oder', 'aber', 'dass', 'ob',
        'literatur', 'bücher', 'artikel', 'texte', 'dokumente'
    ];

    // Konvertiere zu Kleinbuchstaben und teile in Wörter
    let words = searchTerm.toLowerCase().split(/\s+/);
    
    // Entferne Stop-Wörter
    words = words.filter(word => !stopWords.includes(word));
    
    // Füge die verbleibenden Wörter wieder zusammen
    return words.join(' ').trim();
}

// Funktion zur Analyse der Suchbegriffe mit Claude (Claude-Supported Search)
async function analyzeSearchQuery(searchTerm) {
    try {
        const cleanedTerm = cleanSearchQuery(searchTerm);
        
        console.log('\n=== Claude-Analyse Start ===');
        console.log('Bereinigter Suchbegriff:', cleanedTerm);
        
        console.log('Sende Anfrage an Claude...');
        const message = await anthropic.messages.create({
            model: "claude-3-opus-20240229",
            max_tokens: 1024,
            messages: [{
                role: "user",
                content: cleanedTerm
            }],
            system: `Du bist ein Recherchesystem für bibliografische Metadaten aus wissenschaftlichen Bibliotheken.

EINGABE-ANALYSE:
1. Analysiere den Suchbegriff und identifiziere die Hauptkonzepte
2. Generiere EINEN alternativen Suchbegriff, der:
   - inhaltlich verwandt ist
   - andere, aber bedeutungsähnliche Wörter verwendet
   - das gleiche Thema aus einem anderen Blickwinkel beschreibt
   - in der gleichen Sprache wie die Eingabe ist

Antworte IMMER mit diesem JSON-Format:
{
    "analysis": {
        "potentialAuthor": das Wort, das wie ein Name aussieht (wenn gefunden),
        "potentialTitle": die anderen Wörter
    },
    "searchType": "known-item" oder "topic",
    "mainSearchTerm": originale Suchanfrage,
    "alternativeSearchTerm": deutscher alternativer Suchbegriff,
    "filters": [],
    "sort": "relevance"
}`
        });
        console.log('Claude-Antwort erhalten!');
        
        const analysis = JSON.parse(message.content[0].text);
        return analysis;
    } catch (error) {
        console.error('\n=== Claude-Analyse Fehler ===');
        console.error('Fehlertyp:', error.constructor.name);
        console.error('Fehlermeldung:', error.message);
        throw error; // Werfen Sie den Fehler, damit wir ihn in der Konsole sehen
    }
}

app.post('/api/search', async (req, res) => {
    console.log('\n=== NEUE SUCHANFRAGE ===');
    console.log('Zeit:', new Date().toISOString());
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
        
        // Basis-Parameter
        searchParams.append('limit', '20');

        // Standardfelder für alle Suchen - optimierte Liste
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
            // Vollständiges analysis-Objekt erstellen
            analysis = {
                searchType: 'basics',
                mainSearchTerm: searchTerm,
                potentialAuthor: null,
                potentialTitle: null,
                isStandardWork: false,
                alternativeSearchTerm: null
            };
        } else {
            // Normale Analyse durch Claude
            analysis = await analyzeSearchQuery(searchTerm);
        }

        // Bestehende switch-Statement-Logik wird verwendet
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
                
                // Nur nach physischen Büchern suchen
                searchParams.append('filter[]', 'format:"Book"');
                
                const basicTerms = [
                    'Introduction', 'Handbook', 'Textbook',
                    'Basics', 'Guide', 'Manual', 'Overview', 'Review',
                    'Einführung', 'Lehrbuch', 'Grundlagen',
                    'Handbuch', 'Arbeitsbuch'
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

        // Wende zusätzliche Filter an
        if (analysis.filters) {
            analysis.filters.forEach(filter => {
                searchParams.append('filter[]', filter);
            });
        }

        // Debug: URL ausgeben
        const searchUrl = `${VUFIND_API_BASE}/search?${searchParams.toString()}`;
        console.log('\n=== Claude-Supported Search: VuFind Suchanfrage ===');
        console.log('Suchbegriff:', searchTerm);
        console.log('Suchparameter:', Object.fromEntries(searchParams));
        console.log('Vollständige URL:', searchUrl);
        console.log('========================\n');

        const response = await fetch(searchUrl, {
            headers: {
                'User-Agent': 'BookSearch/1.0',
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

        // Debug: Vollständige API-Antwort
        console.log('\n=== Claude-Supported Search: API-Antwort ===');
        console.log('Anzahl gefundener Records:', data.resultCount);
        console.log('Status:', data.status);
        console.log('Vollständige Antwort:', JSON.stringify(data, null, 2));
        console.log('========================\n');

        // Prüfe ob records vorhanden sind
        if (!data.records) {
            console.error('Claude-Supported Search: Keine Records in der Antwort');
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
        console.log('=== Formatierte Server-Antwort ===');
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
    console.log('Server läuft auf Port 3001');
});