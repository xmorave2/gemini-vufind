# Search in vufind using Gemini analysis

# Server.js Documentation

## Overview
This server implements a search interface that connects to a VuFind-based library catalog system. It uses Claude AI to analyze search queries and determine the appropriate search type.

## Installation and running

1. Clone repository
2. Navigate to the project directory
3. Run the following command to install dependencies: 
   ```
   npm install
   ```
4. Create a `.env` file in the root directory and add your Google Gemini API key:
   ```
   GEMINI_API_KEY=your_api_key_here
   ```
5. Start the server:
   ```
    ./run.sh
   ```
6. Navigate to `http://localhost:3001` in your web browser to access the search interface.

## Main Components

### Search Types
The system supports three different search types:

1. **Known-Item Search**
   - Used when searching for specific books/items
   - Searches in Title field
   - Sorts results by year
   - Identified by combinations of author names and title keywords or ID numbers

2. **Topic Search**
   - Used for thematic queries
   - Searches in title and subjects fields
   - Sorts by relevance
   - Can include alternative search terms generated by Claude

3. **Basics Search**
   - Activated via checkbox in frontend
   - Combines user's search term with predefined basic literature terms
   - Searches only in titles
   - Filters for physical books only (`format:"Book"`)
   - Sorts by year
   - Uses terms like "Introduction", "Handbook", "Textbook", etc.

### API Integration

#### VuFind API
- Base URL: [...vufind/api/v1/]
- Implements standard VuFind search API parameters
- Returns JSON responses with bibliographic data

#### Gemini AI Integration
- Uses Google Gemini flash 2.0 model for query analysis
- Determines search type based on input
- Can generate alternative search terms
- Provides structured analysis results

### Search Parameters
- Default limit: 20 results per page
- Standard fields included in results:
  - title
  - authors
  - formats
  - publicationDates
  - publishers
  - languages
  - summary
  - subjects

## Key Functions

### analyzeSearchQuery(searchTerm)
Sends the search term to Claude for analysis and returns structured results including:
- searchType
- mainSearchTerm
- potentialAuthor
- potentialTitle
- alternativeSearchTerm

### Search Request Handler
The main POST endpoint `/api/search` processes search requests by:
1. Receiving search term from frontend
2. Getting analysis from Claude (unless basics search is forced)
3. Building appropriate VuFind API query based on search type
4. Fetching and returning results

## Error Handling
- Includes comprehensive error logging
- Returns formatted error messages to frontend
- Handles API response errors
- Validates search parameters

## Environment Requirements
- Requires Google Gemini API key in .env file
- Needs access to VuFind API endpoint
- Node.js environment
