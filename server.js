const express = require('express');
const cors = require('cors');
const OpenAI = require('openai');
require('dotenv').config();
const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const VUFIND_API_BASE = 'https://hcu-testing-vufind.dev.effective-webwork.de/vufind/api/v1';
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
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
        // Bereinige die Suchanfrage
        const cleanedTerm = cleanSearchQuery(searchTerm);
        
        const completion = await openai.chat.completions.create({
            model: "claude-3-sonnet",
            messages: [
                {
                    role: "system",
                    content: `Du bist ein Experte für bibliothekarische Suchen. Analysiere die Suchanfrage und gib ein JSON-Objekt zurück mit:
                    - searchType: Der passendste Suchtyp (topic/basics/article/known-item)
                    - mainSearchTerm: Der eigentliche Suchbegriff (ohne Stop-Wörter)
                    - filters: Array von Filtern
                    - sort: relevance/publicationDates
                    
                    Regeln für die Analyse:
                    1. Known-Item-Suche (searchType: "known-item"):
                       - Wenn ein spezifischer Titel UND Autor genannt wird
                       - Wenn eine ISBN, DOI oder ISSN genannt wird
                       - Wenn der Suchbegriff in Anführungszeichen steht (exakte Phrase)
                       - Wenn "von [Autorenname]" oder "by [Autorenname]" im Suchbegriff vorkommt
                       - Wenn ein eindeutiger Buchtitel mit Erscheinungsjahr genannt wird
                    
                    2. Wenn der Suchbegriff Wörter wie "Einführung", "Grundlagen", "Handbuch", "Lehrbuch" enthält, verwende "basics"
                    3. Wenn nach aktuellen Forschungsergebnissen oder Artikeln gesucht wird, verwende "article"
                    4. Wenn nach Literatur über eine Person gesucht wird (z.B. "über", "von", "zu", "literatur über"), verwende "topic" mit entsprechenden Filtern
                    5. In allen anderen Fällen verwende "topic"`
                },
                {
                    role: "user",
                    content: cleanedTerm
                }
            ],
            response_format: { type: "json_object" }
        });

        const analysis = JSON.parse(completion.choices[0].message.content);
        console.log('Claude Analysis Result:', analysis);
        return analysis;
    } catch (error) {
        console.error('Claude Analysis Error:', error);
        // Fallback zur Standard-Analyse
        return {
            searchType: 'topic',
            mainSearchTerm: cleanSearchQuery(searchTerm),
            filters: [],
            sort: 'relevance'
        };
    }
}

app.post('/api/search', async (req, res) => {
    const { searchTerm } = req.body;
    
    if (!searchTerm) {
        return res.json({ 
            records: [], 
            resultCount: 0
        });
    }

    try {
        let searchParams = new URLSearchParams();
        
        // Basis-Parameter
        searchParams.append('limit', '20');

        // Standardfelder für alle Suchen
        const standardFields = [
            'title',
            'author',
            'author_primary',
            'author_secondary',
            'author_corporate',
            'authors',
            'formats',
            'subjects',
            'publishDate',
            'edition',
            'cleanIsbn',
            'cleanIssn',
            'cleanDoi',
            'publisher',
            'placesOfPublication',
            'languages',
            'series'
        ];
        
        standardFields.forEach(field => {
            searchParams.append('field[]', field);
        });

        // Füge zusätzliche Felder für die Detailsuche hinzu
        const detailFields = [
            'id',
            'recordtype',
            'fullrecord',
            'source',
            'title_full',
            'title_short',
            'title_sub',
            'title_auth',
            'physical',
            'publisher',
            'publishDate',
            'description',
            'contents',
            'url',
            'note'
        ];

        // Kombiniere alle Felder für die Detailsuche
        const allFields = [...standardFields, ...detailFields];

        // Claude-Analyse der Suchanfrage
        const analysis = await analyzeSearchQuery(searchTerm);
        
        console.log('\n=== Claude-Supported Search: Detaillierte Suchanfragen-Analyse ===');
        console.log('Analyseergebnis:', analysis);
        
        // Parameter basierend auf der Analyse setzen
        switch(analysis.searchType) {
            case 'known-item':
                searchParams.set('type', 'Title');
                searchParams.set('lookfor', analysis.mainSearchTerm);
                break;

            case 'basics':
                const basicTerms = [
                    'Introduction', 'Handbook', 'Textbook',
                    'Fundamentals', 'Principles', 'Basics',
                    'Guide', 'Manual',
                    'Einführung', 'Lehrbuch', 'Grundlagen',
                    'Handbuch', 'Übersicht'
                ];
                
                searchParams.set('type', 'AllFields');
                const titleSubjectQuery = `(title:"${analysis.mainSearchTerm}" OR subjects:"${analysis.mainSearchTerm}")`;
                const basicTermsQuery = `(${basicTerms.join(' OR ')})`;
                searchParams.set('lookfor', `${titleSubjectQuery} AND ${basicTermsQuery}`);
                break;

            case 'article':
                searchParams.set('type', 'AllFields');
                searchParams.set('lookfor', analysis.mainSearchTerm);
                searchParams.append('filter[]', 'publishDate:[2010 TO 2024]');
                searchParams.append('filter[]', 'format:"Article"');
                searchParams.append('sort', 'publishDate desc');
                break;

            case 'topic':
            default:
                searchParams.set('type', 'AllFields');
                searchParams.set('lookfor', analysis.mainSearchTerm);
                if (analysis.searchFields) {
                    analysis.searchFields.forEach(field => {
                        searchParams.append('field[]', field);
                    });
                }
                break;
        }

        // Wende zusätzliche Filter an
        if (analysis.filters) {
            analysis.filters.forEach(filter => {
                searchParams.append('filter[]', filter);
            });
        }

        // Setze Sortierung
        searchParams.append('sort', analysis.sort || 'relevance');

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
            records: await Promise.all(data.records.map(async record => {
                try {
                    // Hole detaillierte Daten für jeden Record basierend auf dem Titel
                    const encodedTitle = encodeURIComponent(record.title);
                    const detailUrl = `${VUFIND_API_BASE}/search?lookfor=${encodedTitle}&type=Title&limit=1&${allFields.map(field => `field[]=${field}`).join('&')}`;
                    
                    console.log('\n=== Detail-Anfrage ===');
                    console.log('URL:', detailUrl);
                    
                    const detailResponse = await fetch(detailUrl, {
                        headers: {
                            'User-Agent': 'BookSearch/1.0',
                            'Accept': 'application/json'
                        }
                    });
                    
                    if (!detailResponse.ok) {
                        throw new Error(`HTTP error! status: ${detailResponse.status}`);
                    }

                    const detailData = await detailResponse.json();
                    
                    if (!detailData.records || detailData.records.length === 0) {
                        throw new Error('Keine Detail-Daten verfügbar');
                    }

                    const detailRecord = detailData.records[0];
                    
                    console.log('\n=== Detail-Daten ===');
                    console.log('Gefundener Detail-Record:', JSON.stringify(detailRecord, null, 2));

                    // Formatierung des Records mit Detail-Daten
                    // Extrahiere Autoren
                    let authors = [];
                    
                    console.log('\n=== Debug: Autorendaten ===');
                    console.log('Rohdaten author:', JSON.stringify(detailRecord.author, null, 2));
                    console.log('Rohdaten authors:', JSON.stringify(detailRecord.authors, null, 2));
                    
                    // Extrahiere Autoren aus dem authors-Objekt
                    if (detailRecord.authors) {
                        console.log('\n=== Verarbeitung der Autorendaten ===');
                        
                        // Füge primäre Autoren hinzu
                        if (detailRecord.authors.primary && detailRecord.authors.primary.length > 0) {
                            console.log('Primäre Autoren:', detailRecord.authors.primary);
                            authors = authors.concat(detailRecord.authors.primary);
                        }
                        
                        // Füge sekundäre Autoren hinzu
                        if (detailRecord.authors.secondary) {
                            const secondaryAuthors = Object.keys(detailRecord.authors.secondary);
                            console.log('Sekundäre Autoren:', secondaryAuthors);
                            authors = authors.concat(secondaryAuthors);
                        }
                        
                        // Füge corporate Autoren hinzu
                        if (detailRecord.authors.corporate && detailRecord.authors.corporate.length > 0) {
                            console.log('Corporate Autoren:', detailRecord.authors.corporate);
                            authors = authors.concat(detailRecord.authors.corporate);
                        }
                    }
                    
                    // Bereinige die Autorennamen (entferne Lebensdaten)
                    authors = authors.map(author => {
                        // Entferne Lebensdaten (z.B. "1929-" oder "1949-2023")
                        return author.replace(/\s+\d{4}(-\d{4})?$/, '');
                    });
                    
                    console.log('Finale Autorenliste:', authors);
                    console.log('========================\n');
                    
                    return {
                        title: detailRecord.title || record.title || 'Kein Titel',
                        authors: authors.length > 0 ? authors : ['Keine Autoren/Editoren'],
                        publishDate: detailRecord.publishDate || 'Kein Jahr',
                        format: detailRecord.formats?.[0] || 'Unbekannt',
                        subjects: detailRecord.subjects || [],
                        edition: detailRecord.edition || 'Unbekannt',
                        isbn: detailRecord.cleanIsbn || detailRecord.isbn?.[0] || 'Unbekannt',
                        publisher: detailRecord.publishers || 'Unbekannt',
                        languages: detailRecord.languages || []
                    };
                } catch (error) {
                    console.error(`Fehler bei der Verarbeitung des Records: ${error.message}`);
                    // Fallback auf minimale Daten bei Fehler
                    return {
                        title: record.title || 'Kein Titel',
                        authors: ['Keine Autoren/Editoren'],
                        publishDate: 'Kein Jahr',
                        formats: 'Unbekannt',
                        subjects: [],
                        edition: 'Unbekannt',
                        isbn: 'Unbekannt',
                        publishers: 'Unbekannt',
                        languages: []
                    };
                }
            })),
            resultCount: data.resultCount || 0,
            searchParams: {
                term: searchTerm,
                parameters: Object.fromEntries(searchParams),
                url: searchUrl
            },
            detectedSearchType: analysis.searchType
        };

        // Debug: Formatierte Antwort
        console.log('Formatted Response:', JSON.stringify(formattedResponse, null, 2));

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