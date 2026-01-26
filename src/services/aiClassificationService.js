/**
 * AI Classification Service
 * Uses Claude API to analyze PDFs and classify them according to visa criteria
 */

const Anthropic = require('@anthropic-ai/sdk');
const pdfParse = require('pdf-parse');
const fs = require('fs');

// Initialize Anthropic client
let anthropic = null;

function getClient() {
  if (!anthropic && process.env.ANTHROPIC_API_KEY) {
    anthropic = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
    });
  }
  return anthropic;
}

// Visa criteria definitions for context
const VISA_CRITERIA = {
  'O-1A': {
    name: 'O-1A (Extraordinary Ability - Sciences/Business)',
    criteria: [
      {
        id: 'awards',
        name: 'Awards & Recognition',
        description: 'Nationally or internationally recognized prizes or awards for excellence in the field',
        examples: ['Industry awards', 'Academic honors', 'Professional recognition', 'Competition wins', 'Grants for exceptional work']
      },
      {
        id: 'membership',
        name: 'Membership in Elite Organizations',
        description: 'Membership in associations requiring outstanding achievements for admission',
        examples: ['Professional societies with selective membership', 'Honor societies', 'Invitation-only organizations', 'Boards of prestigious institutions']
      },
      {
        id: 'published_material',
        name: 'Published Material About You',
        description: 'Published material in professional or major trade publications or major media about you and your work',
        examples: ['News articles featuring your work', 'Interviews in trade publications', 'Profiles in industry media', 'Coverage of your achievements']
      },
      {
        id: 'judging',
        name: 'Judging the Work of Others',
        description: 'Participation as a judge of the work of others in the same or allied field',
        examples: ['Peer review for journals', 'Grant review panels', 'Competition judging', 'Thesis committee membership', 'Conference paper review']
      },
      {
        id: 'original_contributions',
        name: 'Original Contributions',
        description: 'Original scientific, scholarly, or business-related contributions of major significance',
        examples: ['Patents', 'Widely-adopted methodologies', 'Influential research', 'Industry-changing innovations', 'Open source projects with significant adoption']
      },
      {
        id: 'scholarly_articles',
        name: 'Scholarly Articles',
        description: 'Authorship of scholarly articles in professional journals or major media',
        examples: ['Peer-reviewed publications', 'Technical papers', 'Book chapters', 'Industry whitepapers', 'Conference proceedings']
      },
      {
        id: 'critical_role',
        name: 'Critical or Essential Role',
        description: 'Employment in a critical or essential capacity for distinguished organizations',
        examples: ['Leadership positions', 'Key technical roles', 'Founding team member', 'Principal investigator', 'Lead architect/engineer']
      },
      {
        id: 'high_salary',
        name: 'High Salary or Remuneration',
        description: 'Evidence of commanding high salary or remuneration relative to others in the field',
        examples: ['Salary comparisons', 'Compensation packages', 'Equity grants', 'Bonuses', 'Consulting fees']
      }
    ]
  },
  'O-1B': {
    name: 'O-1B (Extraordinary Ability - Arts)',
    criteria: [
      {
        id: 'lead_role',
        name: 'Lead or Starring Role',
        description: 'Lead or starring role in distinguished productions or events',
        examples: ['Lead actor/performer', 'Principal artist', 'Featured role', 'Solo exhibitions', 'Headlining performances']
      },
      {
        id: 'critical_reviews',
        name: 'Critical Reviews',
        description: 'Critical reviews or published material in major publications about achievements',
        examples: ['Reviews in major publications', 'Art criticism', 'Performance reviews', 'Media coverage of work']
      },
      {
        id: 'distinguished_org_role',
        name: 'Lead Role for Distinguished Organizations',
        description: 'Lead or starring role for organizations with distinguished reputation',
        examples: ['Major studio work', 'Prestigious gallery representation', 'Top orchestra/company', 'Renowned institution affiliation']
      },
      {
        id: 'commercial_success',
        name: 'Commercial Success',
        description: 'Record of commercial or critically acclaimed success',
        examples: ['Box office success', 'Album sales', 'Artwork sales', 'Streaming numbers', 'Ticket sales']
      },
      {
        id: 'recognition',
        name: 'Recognition from Organizations/Critics',
        description: 'Recognition for achievements from organizations, critics, or experts',
        examples: ['Awards', 'Nominations', 'Expert endorsements', 'Critical acclaim', 'Industry recognition']
      },
      {
        id: 'original_contributions_art',
        name: 'Original Contributions',
        description: 'Original contributions of major significance to the field',
        examples: ['New techniques', 'Influential style', 'Genre-defining work', 'Innovative approaches']
      }
    ]
  },
  'EB-1A': {
    name: 'EB-1A (Extraordinary Ability)',
    criteria: [
      {
        id: 'awards',
        name: 'Awards',
        description: 'Lesser nationally or internationally recognized prizes or awards for excellence',
        examples: ['Professional awards', 'Academic distinctions', 'Industry recognition', 'Competition prizes']
      },
      {
        id: 'membership',
        name: 'Membership',
        description: 'Membership in associations requiring outstanding achievements',
        examples: ['Selective professional organizations', 'Honor societies', 'Expert panels']
      },
      {
        id: 'published_material',
        name: 'Published Material',
        description: 'Published material about the beneficiary in professional or major publications',
        examples: ['Media coverage', 'Industry articles', 'Profiles', 'Interviews']
      },
      {
        id: 'judging',
        name: 'Judging',
        description: 'Judging the work of others in the same or allied field',
        examples: ['Peer review', 'Panel participation', 'Competition judging']
      },
      {
        id: 'original_contributions',
        name: 'Original Contributions',
        description: 'Original contributions of major significance to the field',
        examples: ['Patents', 'Innovations', 'Influential research', 'Widely-adopted work']
      },
      {
        id: 'scholarly_articles',
        name: 'Scholarly Articles',
        description: 'Authorship of scholarly articles in professional journals or major media',
        examples: ['Publications', 'Research papers', 'Technical articles']
      },
      {
        id: 'exhibitions',
        name: 'Exhibitions',
        description: 'Display of work at artistic exhibitions or showcases',
        examples: ['Gallery shows', 'Museum exhibitions', 'Trade shows', 'Demonstrations']
      },
      {
        id: 'leading_role',
        name: 'Leading or Critical Role',
        description: 'Leading or critical role in distinguished organizations',
        examples: ['Executive positions', 'Key technical roles', 'Founding positions']
      },
      {
        id: 'high_salary',
        name: 'High Salary',
        description: 'High salary or remuneration compared to others in the field',
        examples: ['Above-market compensation', 'Premium rates', 'Exceptional packages']
      },
      {
        id: 'commercial_success',
        name: 'Commercial Success',
        description: 'Commercial success in the performing arts',
        examples: ['Sales figures', 'Revenue metrics', 'Box office performance']
      }
    ]
  },
  'P-1A': {
    name: 'P-1A (Internationally Recognized Athlete)',
    criteria: [
      {
        id: 'international_recognition',
        name: 'International Recognition',
        description: 'International recognition as an athlete',
        examples: ['World rankings', 'International competitions', 'National team membership']
      },
      {
        id: 'team_participation',
        name: 'Team Participation',
        description: 'Participation in international competition with a national team',
        examples: ['Olympics', 'World championships', 'International tournaments']
      },
      {
        id: 'rankings',
        name: 'Rankings',
        description: 'National or international rankings in the sport',
        examples: ['World rankings', 'National rankings', 'League standings']
      },
      {
        id: 'awards_sport',
        name: 'Awards',
        description: 'Significant awards in the sport',
        examples: ['MVP awards', 'Championship titles', 'Athletic honors']
      },
      {
        id: 'recognition_sport',
        name: 'Recognition',
        description: 'Recognition from sports organizations, media, or experts',
        examples: ['Hall of fame', 'All-star selections', 'Expert endorsements']
      },
      {
        id: 'media_coverage',
        name: 'Media Coverage',
        description: 'Media coverage of athletic achievements',
        examples: ['Sports news coverage', 'Feature articles', 'Broadcast coverage']
      }
    ]
  }
};

/**
 * Extract text from PDF
 */
async function extractTextFromPdf(pdfPath) {
  try {
    const dataBuffer = fs.readFileSync(pdfPath);
    const data = await pdfParse(dataBuffer);
    return data.text;
  } catch (error) {
    console.error('Error extracting PDF text:', error.message);
    return null;
  }
}

/**
 * Classify a single document
 */
async function classifyDocument(pdfPath, visaType, documentLabel = '') {
  const client = getClient();
  if (!client) {
    return {
      success: false,
      error: 'Anthropic API key not configured',
    };
  }

  const criteria = VISA_CRITERIA[visaType];
  if (!criteria) {
    return {
      success: false,
      error: `Unknown visa type: ${visaType}`,
    };
  }

  // Extract text from PDF
  const pdfText = await extractTextFromPdf(pdfPath);
  if (!pdfText) {
    return {
      success: false,
      error: 'Could not extract text from PDF',
    };
  }

  // Truncate text if too long
  const maxChars = 15000;
  const truncatedText = pdfText.length > maxChars
    ? pdfText.substring(0, maxChars) + '\n[...truncated...]'
    : pdfText;

  // Build prompt with criteria context
  const criteriaList = criteria.criteria.map(c =>
    `- ${c.name}: ${c.description}\n  Examples: ${c.examples.join(', ')}`
  ).join('\n');

  const prompt = `You are an immigration document classifier. Analyze the following document and determine which ${visaType} visa criterion it best supports.

## ${criteria.name} Criteria:
${criteriaList}

## Document Label: ${documentLabel || 'Not provided'}

## Document Content:
${truncatedText}

## Instructions:
1. Analyze the document content carefully
2. Determine which criterion (if any) this document best supports
3. Provide a confidence score (0.0 to 1.0)
4. Suggest a better label if the current one is unclear

Respond in JSON format:
{
  "criterion_id": "the criterion id (e.g., 'awards', 'judging') or null if doesn't fit any",
  "criterion_name": "full name of the criterion",
  "confidence": 0.0-1.0,
  "reasoning": "brief explanation of why this classification",
  "suggested_label": "improved document label if the original is vague",
  "document_type": "what type of document this is (e.g., 'Award Certificate', 'News Article', 'Patent Document')"
}`;

  try {
    const response = await client.messages.create({
      model: 'claude-3-haiku-20240307',
      max_tokens: 1024,
      messages: [
        { role: 'user', content: prompt }
      ]
    });

    const content = response.content[0].text;

    // Parse JSON from response
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const result = JSON.parse(jsonMatch[0]);
      return {
        success: true,
        ...result,
        visaType,
      };
    }

    return {
      success: false,
      error: 'Could not parse AI response',
      rawResponse: content,
    };

  } catch (error) {
    console.error('AI classification error:', error.message);
    return {
      success: false,
      error: error.message,
    };
  }
}

/**
 * Classify multiple documents
 */
async function classifyDocuments(documents, visaType) {
  const results = [];

  for (const doc of documents) {
    const result = await classifyDocument(doc.path, visaType, doc.label);
    results.push({
      id: doc.id,
      originalLabel: doc.label,
      ...result,
    });

    // Small delay to avoid rate limiting
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  return results;
}

/**
 * Get suggested document name based on content
 */
async function suggestDocumentName(pdfPath) {
  const client = getClient();
  if (!client) {
    return null;
  }

  const pdfText = await extractTextFromPdf(pdfPath);
  if (!pdfText) {
    return null;
  }

  const truncatedText = pdfText.substring(0, 3000);

  try {
    const response = await client.messages.create({
      model: 'claude-3-haiku-20240307',
      max_tokens: 256,
      messages: [
        {
          role: 'user',
          content: `Based on this document content, suggest a clear, descriptive name for this document (max 50 characters).

Document content:
${truncatedText}

Respond with just the suggested name, nothing else.`
        }
      ]
    });

    return response.content[0].text.trim().substring(0, 50);

  } catch (error) {
    console.error('Error suggesting name:', error.message);
    return null;
  }
}

/**
 * Analyze documents for missing criteria
 */
async function analyzeMissingCriteria(classifiedDocuments, visaType) {
  const criteria = VISA_CRITERIA[visaType];
  if (!criteria) {
    return null;
  }

  // Count documents per criterion
  const criteriaCount = {};
  for (const c of criteria.criteria) {
    criteriaCount[c.id] = 0;
  }

  for (const doc of classifiedDocuments) {
    if (doc.success && doc.criterion_id && criteriaCount[doc.criterion_id] !== undefined) {
      criteriaCount[doc.criterion_id]++;
    }
  }

  // Identify missing and weak criteria
  const missing = [];
  const weak = [];
  const strong = [];

  for (const c of criteria.criteria) {
    const count = criteriaCount[c.id];
    if (count === 0) {
      missing.push({ ...c, documentCount: count });
    } else if (count < 3) {
      weak.push({ ...c, documentCount: count });
    } else {
      strong.push({ ...c, documentCount: count });
    }
  }

  return {
    visaType,
    visaName: criteria.name,
    totalDocuments: classifiedDocuments.length,
    criteriaAnalysis: {
      missing,
      weak,
      strong,
    },
    recommendation: generateRecommendation(missing, weak, strong, visaType),
  };
}

function generateRecommendation(missing, weak, strong, visaType) {
  const strongCount = strong.length;
  const weakCount = weak.length;
  const missingCount = missing.length;

  if (strongCount >= 3) {
    return {
      status: 'ready',
      message: `Strong case with ${strongCount} well-documented criteria. Consider filing.`,
    };
  } else if (strongCount >= 2 && weakCount >= 1) {
    return {
      status: 'almost_ready',
      message: `Good progress with ${strongCount} strong criteria. Strengthen ${weak.map(w => w.name).join(', ')} for a stronger case.`,
    };
  } else if (strongCount >= 1) {
    return {
      status: 'building',
      message: `Foundation started. Need more evidence for ${weak.concat(missing).slice(0, 3).map(c => c.name).join(', ')}.`,
    };
  } else {
    return {
      status: 'early_stage',
      message: `Early stage - focus on building evidence for 3+ criteria. Priority: ${missing.slice(0, 3).map(c => c.name).join(', ')}.`,
    };
  }
}

/**
 * Get available visa types
 */
function getAvailableVisaTypes() {
  return Object.keys(VISA_CRITERIA).map(key => ({
    id: key,
    name: VISA_CRITERIA[key].name,
    criteriaCount: VISA_CRITERIA[key].criteria.length,
  }));
}

/**
 * Get criteria for a visa type
 */
function getCriteriaForVisaType(visaType) {
  return VISA_CRITERIA[visaType] || null;
}

module.exports = {
  classifyDocument,
  classifyDocuments,
  suggestDocumentName,
  analyzeMissingCriteria,
  getAvailableVisaTypes,
  getCriteriaForVisaType,
  VISA_CRITERIA,
};
