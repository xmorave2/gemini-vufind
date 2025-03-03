const express = require('express');
const cors = require('cors');
const OpenAI = require('openai');
require('dotenv').config();
const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const VUFIND_API_BASE = 'https://lux.leuphana.de/vufind/api/v1';
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

// Funktion zur Analyse der Suchbegriffe mit Claude
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
                    - searchType: Der passendste Suchtyp (topic/basics/article)
                    - mainSearchTerm: Der eigentliche Suchbegriff (ohne Stop-Wörter)
                    - filters: Array von Filtern
                    - sort: relevance/publicationDates
                    
                    Regeln für die Analyse:
                    1. Wenn der Suchbegriff Wörter wie "Einführung", "Grundlagen", "Handbuch", "Lehrbuch" enthält oder impliziert, verwende "basics"
                    2. Wenn nach aktuellen Forschungsergebnissen oder Artikeln gesucht wird, verwende "article"
                    3. Wenn der Suchbegriff einen oder mehrere Autorennamen enthält (z.B. "macroeconomics mankiw" oder "principles of economics mankiw taylor"), verwende "known-item"
                    4. Wenn nach Literatur über eine Person gesucht wird (z.B. "über", "von", "zu", "literatur über", "zeig mir", "biographie über", "leben von"), verwende "topic" mit entsprechenden Filtern
                    5. In allen anderen Fällen verwende "topic"
                    
                    Beispielantworten:
                    - "zeig mir eine Einführung in die Soziologie" -> {"searchType": "basics", "mainSearchTerm": "soziologie", "filters": [], "sort": "relevance"}
                    - "ich suche nach aktueller Forschung zu KI" -> {"searchType": "article", "mainSearchTerm": "künstliche intelligenz", "filters": ["publicationDates:[2020 TO 2024]"], "sort": "publicationDates"}
                    - "kannst du mir macroeconomics von mankiw finden" -> {"searchType": "known-item", "mainSearchTerm": "macroeconomics", "author": "mankiw", "filters": [], "sort": "relevance"}
                    - "zeig mir biographien über theodor fontane" -> {"searchType": "topic", "mainSearchTerm": "theodor fontane", "filters": ["subject:Biography"], "sort": "relevance"}
                    - "über goethe" -> {"searchType": "topic", "mainSearchTerm": "goethe", "searchFields": ["title", "subject"], "filters": [], "sort": "relevance"}
                    - "Literatur über Nachhaltigkeit" -> {"searchType": "topic", "mainSearchTerm": "nachhaltigkeit", "searchFields": ["title", "subject"], "filters": [], "sort": "relevance"}`
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
    const { searchTerm, searchType } = req.body;
    
    if (!searchTerm) {
        return res.json({ 
            records: [], 
            resultCount: 0
        });
    }

    try {
        let searchParams = new URLSearchParams();
        
        // Basis-Parameter
        searchParams.append('lookfor', searchTerm);
        searchParams.append('limit', '20');
        searchParams.append('type', 'AllFields');

        switch(searchType) {
            case 'standard':
                // Claude-Analyse der Suchanfrage für die Standard-Suche
                const analysis = await analyzeSearchQuery(searchTerm);
                
                // Parameter basierend auf der Analyse setzen
                searchParams.set('type', 'AllFields');
                searchParams.set('lookfor', analysis.mainSearchTerm);
                
                // Felder basierend auf Suchtyp setzen
                switch(analysis.searchType) {
                    case 'topic':
                        // Wenn spezifische Suchfelder definiert sind, verwende diese
                        if (analysis.searchFields) {
                            analysis.searchFields.forEach(field => {
                                searchParams.append('field[]', field);
                            });
                        } else {
                            // Standardfelder für Topic-Suche
                            searchParams.append('field[]', 'title');
                            searchParams.append('field[]', 'subject');
                            searchParams.append('field[]', 'keywords');
                        }
                        
                        // Wenn Biographie-Terme vorhanden sind, füge eine spezielle Titel-Suche hinzu
                        if (analysis.biographyTerms) {
                            const biographyQuery = analysis.biographyTerms.map(term => `title:"${term}"`).join(' OR ');
                            const personQuery = `title:"${analysis.mainSearchTerm}"`;
                            searchParams.set('lookfor', `(${biographyQuery}) AND ${personQuery}`);
                        } else if (analysis.searchFields) {
                            // Wenn spezifische Suchfelder definiert sind, suche in beiden Feldern
                            const fieldQueries = analysis.searchFields.map(field => `${field}:"${analysis.mainSearchTerm}"`);
                            searchParams.set('lookfor', `(${fieldQueries.join(' OR ')})`);
                        }
                        break;
                    case 'basics':
                        searchParams.append('field[]', 'title');
                        searchParams.append('field[]', 'subject');
                        break;
                    case 'article':
                        searchParams.append('field[]', 'title');
                        searchParams.append('field[]', 'subject');
                        break;
                    case 'known-item':
                        searchParams.set('type', 'Combined');
                        searchParams.set('lookfor', analysis.mainSearchTerm);
                        if (analysis.author) {
                            searchParams.append('field[]', 'title');
                            searchParams.append('field[]', 'author');
                            searchParams.append('filter[]', `author:"${analysis.author}"`);
                        }
                        break;
                }

                // Filter anwenden
                analysis.filters.forEach(filter => {
                    searchParams.append('filter[]', filter);
                });

                // Sortierung setzen
                searchParams.append('sort', analysis.sort);
                break;

            case 'known-item':
                searchParams.set('type', 'Combined');
                searchParams.append('field[]', 'title');
                searchParams.append('field[]', 'cleanIsbn');
                searchParams.append('field[]', 'cleanIssn');
                searchParams.append('field[]', 'cleanDoi');
                searchParams.append('sort', 'relevance');
                break;
            
            case 'topic':
                searchParams.set('type', 'AllFields');
                searchParams.set('lookfor', searchTerm);
                searchParams.append('field[]', 'title');
                searchParams.append('field[]', 'subject');
                searchParams.append('field[]', 'keywords');
                 // Wenn es sich um eine Biographie-Suche handelt
                if (searchTerm.toLowerCase().includes('biograph')) {
                    searchParams.append('filter[]', 'subject:Biography');
                }
                searchParams.append('sort', 'relevance');
                break;
            
            case 'basics':
                const basicTerms = [
                    // Englische Begriffe
                    'Introduction', 'Handbook', 'Textbook',
                    'Fundamentals', 'Principles', 'Basics',
                    'Guide', 'Manual',
                    // Deutsche Begriffe
                    'Einführung', 'Lehrbuch', 'Grundlagen',
                    'Handbuch', 'Übersicht'
                ];
                
                searchParams.set('type', 'AllFields');
                // Suche nach dem Suchbegriff im Titel oder Subject
                const titleSubjectQuery = `(title:"${searchTerm}" OR subject:"${searchTerm}")`;
                // Suche nach einem der Grundlagenbegriffe
                const basicTermsQuery = `(${basicTerms.join(' OR ')})`;
                // Kombiniere beide Bedingungen
                const basicSearchQuery = `${titleSubjectQuery} AND ${basicTermsQuery}`;
                searchParams.set('lookfor', basicSearchQuery);
                searchParams.append('sort', 'relevance');
                break;
            
            case 'article':
                searchParams.set('type', 'AllFields');
                searchParams.append('filter[]', 'publicationDates:[2010 TO 2024]');
                searchParams.append('sort', 'publicationDates desc');
                break;
            
            default:
                searchParams.append('sort', 'relevance');
        }

        // Debug: URL ausgeben
        const searchUrl = `${VUFIND_API_BASE}/search?${searchParams.toString()}`;
        console.log('\n=== VuFind Suchanfrage ===');
        console.log('Suchtyp:', searchType);
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

        // Debug: API-Antwort
        console.log('API Response:', JSON.stringify(data, null, 2));

        // Prüfe ob records vorhanden sind
        if (!data.records) {
            console.error('No records in response');
            return res.json({ records: [], resultCount: 0 });
        }

        const formattedResponse = {
            records: data.records.map(record => {
                let contributors = [];
                
                // Verarbeitung der Autoren gemäß der VuFind-Dokumentation
                if (record.authors?.main) {
                    contributors = contributors.concat(record.authors.main);
                }
                
                if (record.authors?.secondary) {
                    contributors = contributors.concat(record.authors.secondary);
                }
                
                if (record.authors?.corporate) {
                    contributors = contributors.concat(record.authors.corporate);
                }

                return {
                    title: record.title || 'Kein Titel',
                    author: contributors.length > 0 ? contributors.join('; ') : 'Keine Autoren/Editoren',
                    publishDate: record.publicationDates?.[0] || 'Kein Jahr',
                    format: Array.isArray(record.formats) ? record.formats[0] : 'Unbekannt',
                    subjects: record.subjects || [],
                    edition: record.edition || 'Unbekannt',
                    isbn: record.cleanIsbn || 'Unbekannt',
                    doi: record.cleanDoi || 'Unbekannt',
                    issn: record.cleanIssn || 'Unbekannt',
                    publisher: record.publishers?.[0] || 'Unbekannt',
                    placeOfPublication: record.placesOfPublication?.[0] || 'Unbekannt',
                    summary: record.summary?.[0] || 'Keine Zusammenfassung verfügbar',
                    languages: record.languages || [],
                    series: record.series || []
                };
            }),
            resultCount: data.resultCount || 0,
            searchParams: {
                type: searchType,
                term: searchTerm,
                parameters: Object.fromEntries(searchParams),
                url: searchUrl
            }
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