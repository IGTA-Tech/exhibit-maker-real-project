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

// Enhanced Visa criteria definitions with comprehensive RAG data
// Based on IGTA's 500+ approved cases and USCIS requirements
const VISA_CRITERIA = {
  'O-1A': {
    name: 'O-1A (Extraordinary Ability - Sciences/Business)',
    requirement: 'Must meet 3 of 8 criteria. Recommend building 5-6 for strong application.',
    criteria: [
      {
        id: 'awards',
        name: 'Awards & Recognition',
        description: 'Nationally or internationally recognized prizes or awards for excellence in the field',
        uscisWants: 'Evidence of nationally or internationally recognized prizes or awards for excellence. The awards should be significant in the field, not merely participation certificates.',
        examples: ['Industry awards (tech, business)', 'Hackathon wins', 'Competition prizes', 'Academic honors', 'Professional recognition', 'Grants for exceptional work'],
        documentTypes: [
          'Award certificate or letter',
          'Press release about award',
          'Award criteria documentation',
          'List of past recipients',
          'Photo of award ceremony',
          'Organization letter confirming significance'
        ],
        timeline: '3-6 months to first award',
        evidenceStrength: {
          strong: ['Major industry award (e.g., ACM, IEEE)', 'International competition win', 'Government/foundation grant'],
          medium: ['Regional hackathon win', 'Company-wide recognition', 'Academic scholarship'],
          weak: ['Participation certificate', 'Completion certificate', 'Internal team award']
        }
      },
      {
        id: 'membership',
        name: 'Membership in Elite Organizations',
        description: 'Membership in associations requiring outstanding achievements for admission',
        uscisWants: 'Membership in associations that require outstanding achievements as judged by recognized experts. Must show the organization has selective criteria for membership.',
        examples: ['IEEE Senior Member', 'ACM Distinguished Member', 'Forbes Technology Council', 'Invitation-only professional groups', 'Honor societies with achievement requirements', 'Boards of prestigious institutions'],
        documentTypes: [
          'Membership certificate/card',
          'Organization letter confirming membership',
          'Membership criteria documentation',
          'Evidence of selectivity (acceptance rate)',
          'List of notable members',
          'Invitation letter (if invitation-only)'
        ],
        timeline: '2-6 months depending on organization',
        evidenceStrength: {
          strong: ['IEEE/ACM Senior/Fellow', 'Forbes councils', 'National Academy membership'],
          medium: ['Professional society membership', 'Alumni honor society', 'Industry consortium membership'],
          weak: ['General professional association', 'Paid membership organization', 'Open enrollment group']
        }
      },
      {
        id: 'published_material',
        name: 'Published Material About You',
        description: 'Published material in professional or major trade publications or major media about you and your work',
        uscisWants: 'Published material in professional or major trade publications about the beneficiary and their work. The publication should have significant circulation or readership.',
        examples: ['Feature articles in TechCrunch, Forbes, VentureBeat', 'Industry publication profiles', 'Podcast interviews', 'News coverage of your work', 'Professional journal features', 'Company engineering blog features'],
        documentTypes: [
          'Full article copy with publication info',
          'Screenshot with URL and date',
          'Publication circulation/readership stats',
          'Author bio from publication',
          'Translation (if not in English)',
          'Evidence of publication prestige'
        ],
        timeline: '2-4 months to first feature',
        evidenceStrength: {
          strong: ['TechCrunch, Forbes, Wired feature', 'Major newspaper profile', 'Industry journal cover story'],
          medium: ['Trade publication article', 'Podcast interview', 'Regional media coverage'],
          weak: ['Blog mention', 'Social media feature', 'Self-published content about you']
        }
      },
      {
        id: 'judging',
        name: 'Judging the Work of Others',
        description: 'Participation as a judge of the work of others in the same or allied field',
        uscisWants: 'Evidence of participation as a judge of the work of others individually or on a panel. Must be judging peers in your field, not subordinates.',
        examples: ['Hackathon judge', 'Competition evaluator', 'Peer reviewer for journals', 'Grant proposal reviewer', 'Technical interview panelist', 'Award committee member', 'Thesis committee membership', 'Conference paper reviewer'],
        documentTypes: [
          'Invitation to judge letter',
          'Certificate of judging participation',
          'Peer review confirmation emails',
          'Editorial board appointment letter',
          'Grant review panel documentation',
          'List of submissions reviewed'
        ],
        timeline: '4-8 months (requires established reputation first)',
        evidenceStrength: {
          strong: ['IEEE/ACM paper reviewer', 'NSF/NIH grant reviewer', 'Major competition judge'],
          medium: ['Conference paper reviewer', 'Hackathon judge', 'Internal interview panelist'],
          weak: ['Code review for team', 'Informal feedback role', 'Student project evaluator']
        }
      },
      {
        id: 'original_contributions',
        name: 'Original Contributions',
        description: 'Original scientific, scholarly, or business-related contributions of major significance',
        uscisWants: 'Evidence of original contributions of major significance to the field. Must show the contribution has been implemented, adopted, or recognized by others.',
        examples: ['Patents filed or granted', 'Open source projects with significant adoption', 'Novel algorithms or methodologies', 'Products with measurable impact', 'Research with citations', 'Innovations implemented at scale', 'Industry-changing innovations'],
        documentTypes: [
          'Patent certificate or application',
          'GitHub stars/forks/downloads stats',
          'Citation count documentation',
          'Letters from experts on significance',
          'Product usage/adoption metrics',
          'Implementation at other companies',
          'Technical documentation of innovation'
        ],
        timeline: 'Ongoing throughout program',
        evidenceStrength: {
          strong: ['Granted patent', 'Open source with 1000+ stars', 'Widely-cited research'],
          medium: ['Patent pending', 'Adopted methodology', 'Product feature used by many'],
          weak: ['Internal tool', 'Minor optimization', 'Unpublished work']
        }
      },
      {
        id: 'scholarly_articles',
        name: 'Scholarly Articles',
        description: 'Authorship of scholarly articles in professional journals or major media',
        uscisWants: 'Evidence of authorship of scholarly articles in professional or major trade publications. Articles should demonstrate expertise and be available to the professional community.',
        examples: ['Technical blog posts on recognized platforms', 'Peer-reviewed journal publications', 'Conference papers', 'Industry white papers', 'Book chapters', 'Major media bylines'],
        documentTypes: [
          'Full article copy',
          'Journal/publication information',
          'Citation count',
          'Acceptance letter from publication',
          'Conference proceedings documentation',
          'Readership/view statistics'
        ],
        timeline: 'Articles begin month 1',
        evidenceStrength: {
          strong: ['Peer-reviewed journal', 'Top conference paper', 'Book chapter'],
          medium: ['Industry whitepaper', 'Technical blog on major platform', 'Trade publication'],
          weak: ['Personal blog post', 'Company internal docs', 'Social media content']
        }
      },
      {
        id: 'critical_role',
        name: 'Critical or Essential Role',
        description: 'Employment in a critical or essential capacity for distinguished organizations',
        uscisWants: 'Evidence of employment in a critical or essential capacity for organizations with a distinguished reputation. Must show the organization is distinguished and your role was critical to its success.',
        examples: ['Lead engineer on major product', 'Key contributor to Fortune 500 project', 'Essential team member for startup success', 'Critical role in high-profile initiative', 'Leadership positions', 'Founding team member', 'Principal investigator', 'Lead architect/engineer'],
        documentTypes: [
          'Employment verification letter',
          'Job description with responsibilities',
          'Organizational chart showing position',
          'Performance reviews highlighting impact',
          'Letters from supervisors on critical role',
          'Company reputation documentation',
          'Project success metrics',
          'Recommendation letters'
        ],
        timeline: 'Ongoing throughout program',
        evidenceStrength: {
          strong: ['C-level/VP at recognized company', 'Founding engineer at funded startup', 'Lead on billion-dollar product'],
          medium: ['Senior engineer at known company', 'Tech lead on shipped product', 'Key contributor to successful project'],
          weak: ['Junior role', 'Support function', 'Undefined contribution']
        }
      },
      {
        id: 'high_salary',
        name: 'High Salary or Remuneration',
        description: 'Evidence of commanding high salary or remuneration relative to others in the field',
        uscisWants: 'Evidence of high salary or remuneration compared to others in the field. Must provide salary data comparisons to demonstrate above-market compensation.',
        examples: ['Salary above 90th percentile for role/location', 'High consulting rates', 'Significant equity compensation', 'Premium rates compared to peers', 'Bonuses for exceptional performance'],
        documentTypes: [
          'Offer letter with compensation',
          'W-2 or pay stubs',
          'Equity grant documentation',
          'Salary comparison data (BLS, Glassdoor, Levels.fyi)',
          'Expert letter on compensation significance',
          'Consulting rate documentation',
          'Bonus/incentive documentation'
        ],
        timeline: 'Throughout program as opportunities arise',
        evidenceStrength: {
          strong: ['Top 10% salary with documentation', 'Significant equity at valued company', 'Premium consulting rates'],
          medium: ['Above-average salary', 'Standard equity package', 'Performance bonuses'],
          weak: ['Average market salary', 'No comparative data', 'Below-market compensation']
        }
      }
    ]
  },
  'O-1B': {
    name: 'O-1B (Extraordinary Ability - Arts)',
    requirement: 'Must demonstrate distinction in the arts field.',
    criteria: [
      {
        id: 'lead_role',
        name: 'Lead or Starring Role',
        description: 'Lead or starring role in distinguished productions or events',
        uscisWants: 'Evidence of having performed in a lead, starring, or critical role for organizations and establishments with distinguished reputations.',
        examples: ['Lead actor/performer', 'Principal artist', 'Featured role', 'Solo exhibitions', 'Headlining performances'],
        documentTypes: [
          'Contract showing role',
          'Program/credits listing',
          'Production materials',
          'Reviews mentioning role',
          'Organization reputation evidence'
        ],
        timeline: 'Ongoing',
        evidenceStrength: {
          strong: ['Lead in major production', 'Headlining world tour', 'Solo at major venue'],
          medium: ['Supporting role in known production', 'Featured performer', 'Group exhibition'],
          weak: ['Background role', 'Local venue', 'Amateur production']
        }
      },
      {
        id: 'critical_reviews',
        name: 'Critical Reviews',
        description: 'Critical reviews or published material in major publications about achievements',
        uscisWants: 'Published material in professional or major trade publications or major media about the beneficiary relating to work in the field.',
        examples: ['Reviews in major publications', 'Art criticism', 'Performance reviews', 'Media coverage of work'],
        documentTypes: [
          'Full review copies',
          'Publication information',
          'Circulation data',
          'Critic credentials'
        ],
        timeline: '2-4 months',
        evidenceStrength: {
          strong: ['Major newspaper/magazine review', 'Industry publication feature'],
          medium: ['Trade publication review', 'Regional media coverage'],
          weak: ['Blog review', 'Self-promotion material']
        }
      },
      {
        id: 'distinguished_org_role',
        name: 'Lead Role for Distinguished Organizations',
        description: 'Lead or starring role for organizations with distinguished reputation',
        uscisWants: 'Evidence of performing in a lead or starring role for organizations with distinguished reputations.',
        examples: ['Major studio work', 'Prestigious gallery representation', 'Top orchestra/company', 'Renowned institution affiliation'],
        documentTypes: [
          'Contract/agreement',
          'Organization reputation documentation',
          'Role description',
          'Credits/programs'
        ],
        timeline: 'Ongoing',
        evidenceStrength: {
          strong: ['Major studio/label', 'Top-tier gallery', 'Renowned orchestra'],
          medium: ['Regional company', 'Known gallery', 'Established venue'],
          weak: ['Unknown organization', 'Local only', 'No reputation evidence']
        }
      },
      {
        id: 'commercial_success',
        name: 'Commercial Success',
        description: 'Record of commercial or critically acclaimed success',
        uscisWants: 'Evidence of commercial or critically acclaimed success, shown by box office receipts, record/video sales, or other indicators.',
        examples: ['Box office success', 'Album sales', 'Artwork sales', 'Streaming numbers', 'Ticket sales'],
        documentTypes: [
          'Sales reports',
          'Box office data',
          'Streaming statistics',
          'Sales receipts',
          'Chart positions'
        ],
        timeline: 'Ongoing',
        evidenceStrength: {
          strong: ['Gold/Platinum record', 'Blockbuster box office', 'Major auction sales'],
          medium: ['Charting release', 'Profitable production', 'Steady sales'],
          weak: ['Minimal sales data', 'Free distribution', 'No verifiable numbers']
        }
      },
      {
        id: 'recognition',
        name: 'Recognition from Organizations/Critics',
        description: 'Recognition for achievements from organizations, critics, or experts',
        uscisWants: 'Significant recognition for achievements from organizations, critics, government agencies, or other recognized experts.',
        examples: ['Awards', 'Nominations', 'Expert endorsements', 'Critical acclaim', 'Industry recognition'],
        documentTypes: [
          'Award certificates',
          'Nomination letters',
          'Expert testimonials',
          'Recognition documentation'
        ],
        timeline: '3-6 months',
        evidenceStrength: {
          strong: ['Grammy/Oscar/Emmy nomination', 'Major award win', 'Government recognition'],
          medium: ['Industry award', 'Critics choice', 'Regional recognition'],
          weak: ['Participation award', 'Self-nomination', 'Unknown award']
        }
      },
      {
        id: 'original_contributions_art',
        name: 'Original Contributions',
        description: 'Original contributions of major significance to the field',
        uscisWants: 'Evidence of original artistic contributions of major significance to the field.',
        examples: ['New techniques', 'Influential style', 'Genre-defining work', 'Innovative approaches'],
        documentTypes: [
          'Documentation of innovation',
          'Expert letters on significance',
          'Evidence of adoption by others',
          'Publications about contribution'
        ],
        timeline: 'Ongoing',
        evidenceStrength: {
          strong: ['Industry-wide adopted technique', 'Genre-defining work', 'Widely-taught method'],
          medium: ['Recognized innovation', 'Cited by others', 'Published technique'],
          weak: ['Personal style', 'No external recognition', 'Unverified claims']
        }
      }
    ]
  },
  'EB-1A': {
    name: 'EB-1A (Extraordinary Ability - Green Card)',
    requirement: 'Must meet 3 of 10 criteria AND demonstrate sustained national/international acclaim.',
    criteria: [
      {
        id: 'awards',
        name: 'Awards',
        description: 'Lesser nationally or internationally recognized prizes or awards for excellence',
        uscisWants: 'Documentation of receipt of lesser nationally or internationally recognized prizes or awards for excellence.',
        examples: ['Professional awards', 'Academic distinctions', 'Industry recognition', 'Competition prizes'],
        documentTypes: ['Award certificates', 'Award criteria', 'Past recipients list', 'Organization reputation'],
        timeline: '3-6 months',
        evidenceStrength: {
          strong: ['National/international award', 'Prestigious grant'],
          medium: ['Regional award', 'Industry recognition'],
          weak: ['Local award', 'Participation certificate']
        }
      },
      {
        id: 'membership',
        name: 'Membership',
        description: 'Membership in associations requiring outstanding achievements',
        uscisWants: 'Documentation of membership in associations requiring outstanding achievements, as judged by recognized experts.',
        examples: ['Selective professional organizations', 'Honor societies', 'Expert panels'],
        documentTypes: ['Membership certificate', 'Membership criteria', 'Selection process documentation'],
        timeline: '2-6 months',
        evidenceStrength: {
          strong: ['National academy', 'Elite professional society'],
          medium: ['Honor society', 'Industry group with requirements'],
          weak: ['Open membership organization', 'Paid membership only']
        }
      },
      {
        id: 'published_material',
        name: 'Published Material',
        description: 'Published material about the beneficiary in professional or major publications',
        uscisWants: 'Published material about the beneficiary in professional or major trade publications or other major media.',
        examples: ['Media coverage', 'Industry articles', 'Profiles', 'Interviews'],
        documentTypes: ['Full articles', 'Publication stats', 'URL/date evidence'],
        timeline: '2-4 months',
        evidenceStrength: {
          strong: ['Major media feature', 'National publication'],
          medium: ['Trade publication', 'Regional coverage'],
          weak: ['Blog mention', 'Self-published']
        }
      },
      {
        id: 'judging',
        name: 'Judging',
        description: 'Judging the work of others in the same or allied field',
        uscisWants: 'Evidence of participation as a judge of the work of others in the same or an allied field of specification.',
        examples: ['Peer review', 'Panel participation', 'Competition judging'],
        documentTypes: ['Invitation letters', 'Review confirmations', 'Panel appointments'],
        timeline: '4-8 months',
        evidenceStrength: {
          strong: ['Major journal reviewer', 'Grant panel member'],
          medium: ['Conference reviewer', 'Competition judge'],
          weak: ['Internal reviewer', 'Student evaluator']
        }
      },
      {
        id: 'original_contributions',
        name: 'Original Contributions',
        description: 'Original contributions of major significance to the field',
        uscisWants: 'Evidence of original scientific, scholarly, artistic, athletic, or business-related contributions of major significance.',
        examples: ['Patents', 'Innovations', 'Influential research', 'Widely-adopted work'],
        documentTypes: ['Patent documents', 'Citation evidence', 'Adoption metrics', 'Expert letters'],
        timeline: 'Ongoing',
        evidenceStrength: {
          strong: ['Multiple patents', 'Highly-cited work', 'Industry standard'],
          medium: ['Patent pending', 'Some citations', 'Adopted by others'],
          weak: ['Internal only', 'No external validation']
        }
      },
      {
        id: 'scholarly_articles',
        name: 'Scholarly Articles',
        description: 'Authorship of scholarly articles in professional journals or major media',
        uscisWants: 'Evidence of authorship of scholarly articles in professional or major trade publications or other major media.',
        examples: ['Publications', 'Research papers', 'Technical articles'],
        documentTypes: ['Full articles', 'Journal information', 'Citation counts'],
        timeline: 'Month 1+',
        evidenceStrength: {
          strong: ['Top-tier journal', 'High citations'],
          medium: ['Peer-reviewed publication', 'Conference paper'],
          weak: ['Non-peer-reviewed', 'Blog post']
        }
      },
      {
        id: 'exhibitions',
        name: 'Exhibitions',
        description: 'Display of work at artistic exhibitions or showcases',
        uscisWants: 'Evidence of display of work at artistic exhibitions or showcases.',
        examples: ['Gallery shows', 'Museum exhibitions', 'Trade shows', 'Demonstrations'],
        documentTypes: ['Exhibition catalogs', 'Venue information', 'Attendance data'],
        timeline: 'Ongoing',
        evidenceStrength: {
          strong: ['Major museum', 'International exhibition'],
          medium: ['Known gallery', 'Industry trade show'],
          weak: ['Local venue', 'Self-organized']
        }
      },
      {
        id: 'leading_role',
        name: 'Leading or Critical Role',
        description: 'Leading or critical role in distinguished organizations',
        uscisWants: 'Evidence of performing in a leading or critical role for organizations with distinguished reputations.',
        examples: ['Executive positions', 'Key technical roles', 'Founding positions'],
        documentTypes: ['Employment letters', 'Org charts', 'Impact documentation'],
        timeline: 'Ongoing',
        evidenceStrength: {
          strong: ['C-level/founder', 'Lead at major company'],
          medium: ['Senior role', 'Key contributor'],
          weak: ['Junior position', 'Support role']
        }
      },
      {
        id: 'high_salary',
        name: 'High Salary',
        description: 'High salary or remuneration compared to others in the field',
        uscisWants: 'Evidence of commanding a high salary or other significantly high remuneration in relation to others.',
        examples: ['Above-market compensation', 'Premium rates', 'Exceptional packages'],
        documentTypes: ['Offer letters', 'W-2s', 'Salary comparisons'],
        timeline: 'Ongoing',
        evidenceStrength: {
          strong: ['Top 10% documented', 'Exceptional equity'],
          medium: ['Above average', 'Good equity'],
          weak: ['Average salary', 'No comparison data']
        }
      },
      {
        id: 'commercial_success',
        name: 'Commercial Success',
        description: 'Commercial success in the performing arts',
        uscisWants: 'Evidence of commercial successes in the performing arts, shown by box office receipts, record/video/cassette sales, etc.',
        examples: ['Sales figures', 'Revenue metrics', 'Box office performance'],
        documentTypes: ['Sales reports', 'Financial statements', 'Chart positions'],
        timeline: 'Ongoing',
        evidenceStrength: {
          strong: ['Verified high sales', 'Chart success'],
          medium: ['Profitable work', 'Steady sales'],
          weak: ['No verifiable data', 'Minimal sales']
        }
      }
    ]
  },
  'P-1A': {
    name: 'P-1A (Internationally Recognized Athlete)',
    requirement: 'Must demonstrate international recognition in athletics.',
    criteria: [
      {
        id: 'international_recognition',
        name: 'International Recognition',
        description: 'International recognition as an athlete',
        uscisWants: 'Evidence of international recognition as an athlete based on actual achievements.',
        examples: ['World rankings', 'International competitions', 'National team membership'],
        documentTypes: ['Ranking documentation', 'Competition results', 'Team roster'],
        timeline: 'Based on career',
        evidenceStrength: {
          strong: ['Top 50 world ranking', 'Multiple international wins'],
          medium: ['National ranking', 'International competition participation'],
          weak: ['Regional only', 'No ranking']
        }
      },
      {
        id: 'team_participation',
        name: 'Team Participation',
        description: 'Participation in international competition with a national team',
        uscisWants: 'Evidence of participation with a national team in international competition.',
        examples: ['Olympics', 'World championships', 'International tournaments'],
        documentTypes: ['Team roster', 'Competition documentation', 'Federation letters'],
        timeline: 'Based on career',
        evidenceStrength: {
          strong: ['Olympic team', 'World championship team'],
          medium: ['Continental championship', 'International tournament'],
          weak: ['Youth/amateur international', 'Friendly matches only']
        }
      },
      {
        id: 'rankings',
        name: 'Rankings',
        description: 'National or international rankings in the sport',
        uscisWants: 'Documentation of ranking in the sport, if the sport has international rankings.',
        examples: ['World rankings', 'National rankings', 'League standings'],
        documentTypes: ['Official ranking lists', 'Federation documentation', 'Historical rankings'],
        timeline: 'Current',
        evidenceStrength: {
          strong: ['Top 100 world', 'National champion'],
          medium: ['Top national ranking', 'League leader'],
          weak: ['Low ranking', 'No official ranking']
        }
      },
      {
        id: 'awards_sport',
        name: 'Awards',
        description: 'Significant awards in the sport',
        uscisWants: 'Documentation of receipt of significant awards in the sport.',
        examples: ['MVP awards', 'Championship titles', 'Athletic honors'],
        documentTypes: ['Award certificates', 'Medal documentation', 'Trophy records'],
        timeline: 'Career-based',
        evidenceStrength: {
          strong: ['Olympic/World medal', 'Major championship'],
          medium: ['National championship', 'League MVP'],
          weak: ['Local award', 'Participation medal']
        }
      },
      {
        id: 'recognition_sport',
        name: 'Recognition',
        description: 'Recognition from sports organizations, media, or experts',
        uscisWants: 'Significant recognition for achievements from organizations, critics, government agencies, or other recognized experts.',
        examples: ['Hall of fame', 'All-star selections', 'Expert endorsements'],
        documentTypes: ['Selection documentation', 'Expert letters', 'Media features'],
        timeline: 'Career-based',
        evidenceStrength: {
          strong: ['Hall of Fame', 'National recognition award'],
          medium: ['All-star selection', 'Federation recognition'],
          weak: ['Team award', 'Local recognition']
        }
      },
      {
        id: 'media_coverage',
        name: 'Media Coverage',
        description: 'Media coverage of athletic achievements',
        uscisWants: 'Published material about the beneficiary relating to the person\'s work in the sport.',
        examples: ['Sports news coverage', 'Feature articles', 'Broadcast coverage'],
        documentTypes: ['Article copies', 'Broadcast recordings', 'Publication information'],
        timeline: '2-4 months',
        evidenceStrength: {
          strong: ['ESPN/major network feature', 'National newspaper'],
          medium: ['Regional sports media', 'Sports website'],
          weak: ['Local coverage only', 'Team website']
        }
      }
    ]
  },
  'EB-2-NIW': {
    name: 'EB-2 NIW (National Interest Waiver)',
    requirement: 'Must demonstrate work is in the national interest of the United States.',
    criteria: [
      {
        id: 'substantial_merit',
        name: 'Substantial Merit & National Importance',
        description: 'Work has substantial merit and national importance',
        uscisWants: 'Evidence that the proposed endeavor has both substantial merit and national importance.',
        examples: ['Research advancing national priorities', 'Work in critical industries', 'Addressing national challenges', 'Economic impact potential'],
        documentTypes: [
          'Research proposals',
          'Business plans',
          'Government policy alignment',
          'Letters from experts on national importance',
          'Industry analysis'
        ],
        timeline: 'Depends on career stage',
        evidenceStrength: {
          strong: ['Government-funded research', 'Critical infrastructure work', 'National defense relevance'],
          medium: ['Industry-advancing work', 'Regional economic impact', 'Healthcare innovation'],
          weak: ['Personal business only', 'Local impact only', 'No clear national benefit']
        }
      },
      {
        id: 'well_positioned',
        name: 'Well Positioned to Advance',
        description: 'Beneficiary is well positioned to advance the proposed endeavor',
        uscisWants: 'Evidence that the beneficiary is well positioned to advance the proposed endeavor based on education, skills, knowledge, record of success, and future plans.',
        examples: ['Track record of success', 'Relevant expertise', 'Resources and support', 'Concrete plans'],
        documentTypes: [
          'Resume/CV',
          'Degrees and certifications',
          'Past project documentation',
          'Letters of support',
          'Future plans documentation'
        ],
        timeline: 'Based on career history',
        evidenceStrength: {
          strong: ['PhD with strong publication record', 'Proven track record', 'Secured resources'],
          medium: ['Masters with relevant experience', 'Some demonstrated success', 'Support letters'],
          weak: ['No track record', 'Vague plans', 'No supporting evidence']
        }
      },
      {
        id: 'national_benefit',
        name: 'Beneficial to Waive Requirements',
        description: 'On balance, it would be beneficial to the US to waive job offer and labor certification',
        uscisWants: 'Evidence that on balance, it would be beneficial to the United States to waive the requirements of a job offer and labor certification.',
        examples: ['Unique expertise', 'Urgent need in field', 'US interests served better without employer sponsorship'],
        documentTypes: [
          'Expert letters explaining waiver benefit',
          'Documentation of unique qualifications',
          'Evidence employer sponsorship would delay/impede work',
          'Industry shortage documentation'
        ],
        timeline: 'At time of filing',
        evidenceStrength: {
          strong: ['Truly unique expertise', 'Critical shortage area', 'Multiple expert endorsements'],
          medium: ['Specialized skills', 'High-demand field', 'Some expert support'],
          weak: ['Common skills', 'No urgency shown', 'No compelling case for waiver']
        }
      }
    ]
  }
};

// Document type mapping for AI classification
const DOCUMENT_TYPE_MAP = {
  // Awards & Recognition
  'award_certificate': { criterion: 'awards', label: 'Award Certificate' },
  'award_letter': { criterion: 'awards', label: 'Award Notification Letter' },
  'award_press_release': { criterion: 'awards', label: 'Award Press Release' },
  'hackathon_certificate': { criterion: 'awards', label: 'Hackathon Win Certificate' },
  'grant_award': { criterion: 'awards', label: 'Grant Award Letter' },

  // Membership
  'membership_certificate': { criterion: 'membership', label: 'Membership Certificate' },
  'membership_letter': { criterion: 'membership', label: 'Membership Confirmation Letter' },
  'invitation_letter': { criterion: 'membership', label: 'Invitation to Join Letter' },
  'membership_criteria': { criterion: 'membership', label: 'Membership Criteria Documentation' },

  // Published Material About You
  'news_article': { criterion: 'published_material', label: 'News Article About Beneficiary' },
  'magazine_feature': { criterion: 'published_material', label: 'Magazine Feature Article' },
  'interview_transcript': { criterion: 'published_material', label: 'Published Interview' },
  'media_coverage': { criterion: 'published_material', label: 'Media Coverage' },
  'profile_piece': { criterion: 'published_material', label: 'Professional Profile' },

  // Judging
  'peer_review_confirmation': { criterion: 'judging', label: 'Peer Review Confirmation' },
  'judge_invitation': { criterion: 'judging', label: 'Judge Invitation Letter' },
  'review_panel_appointment': { criterion: 'judging', label: 'Review Panel Appointment' },
  'editorial_board': { criterion: 'judging', label: 'Editorial Board Appointment' },

  // Original Contributions
  'patent_certificate': { criterion: 'original_contributions', label: 'Patent Certificate' },
  'patent_application': { criterion: 'original_contributions', label: 'Patent Application' },
  'github_stats': { criterion: 'original_contributions', label: 'Open Source Project Statistics' },
  'citation_report': { criterion: 'original_contributions', label: 'Citation Report' },
  'expert_letter': { criterion: 'original_contributions', label: 'Expert Letter on Contributions' },
  'adoption_evidence': { criterion: 'original_contributions', label: 'Adoption/Implementation Evidence' },

  // Scholarly Articles
  'journal_article': { criterion: 'scholarly_articles', label: 'Journal Publication' },
  'conference_paper': { criterion: 'scholarly_articles', label: 'Conference Paper' },
  'whitepaper': { criterion: 'scholarly_articles', label: 'Industry Whitepaper' },
  'book_chapter': { criterion: 'scholarly_articles', label: 'Book Chapter' },
  'technical_blog': { criterion: 'scholarly_articles', label: 'Technical Blog Post' },

  // Critical Role
  'employment_letter': { criterion: 'critical_role', label: 'Employment Verification Letter' },
  'recommendation_letter': { criterion: 'critical_role', label: 'Recommendation Letter' },
  'org_chart': { criterion: 'critical_role', label: 'Organizational Chart' },
  'performance_review': { criterion: 'critical_role', label: 'Performance Review' },
  'project_documentation': { criterion: 'critical_role', label: 'Project Documentation' },

  // High Salary
  'offer_letter': { criterion: 'high_salary', label: 'Offer Letter' },
  'w2_tax_form': { criterion: 'high_salary', label: 'W-2 Tax Form' },
  'pay_stub': { criterion: 'high_salary', label: 'Pay Stub' },
  'salary_comparison': { criterion: 'high_salary', label: 'Salary Comparison Data' },
  'equity_documentation': { criterion: 'high_salary', label: 'Equity Grant Documentation' },

  // General Supporting
  'resume_cv': { criterion: null, label: 'Resume/CV' },
  'degree_certificate': { criterion: null, label: 'Degree Certificate' },
  'transcript': { criterion: null, label: 'Academic Transcript' },
  'passport': { criterion: null, label: 'Passport Copy' },
  'i94': { criterion: null, label: 'I-94 Travel Record' },
  'support_letter': { criterion: null, label: 'Support Letter' }
};

// Eligibility scoring thresholds (from RAG data)
const ELIGIBILITY_SCORES = {
  'O-1_READY': 85,      // 85%+ on assessment = Ready to file
  'O-1_DEVELOPMENT': 60, // 60-84% = Needs evidence building
  'O-1_NOT_VIABLE': 60   // Below 60% = May not be viable for O-1
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
 * Classify a single document with enhanced RAG data
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

  // Build enhanced prompt with comprehensive RAG data
  const criteriaList = criteria.criteria.map(c => {
    let entry = `### ${c.id.toUpperCase()}: ${c.name}\n`;
    entry += `**Description:** ${c.description}\n`;
    if (c.uscisWants) {
      entry += `**What USCIS Wants:** ${c.uscisWants}\n`;
    }
    entry += `**Document Types:** ${c.documentTypes ? c.documentTypes.join(', ') : c.examples.join(', ')}\n`;
    if (c.evidenceStrength) {
      entry += `**Strong Evidence:** ${c.evidenceStrength.strong.join(', ')}\n`;
      entry += `**Medium Evidence:** ${c.evidenceStrength.medium.join(', ')}\n`;
      entry += `**Weak Evidence:** ${c.evidenceStrength.weak.join(', ')}\n`;
    }
    return entry;
  }).join('\n');

  const prompt = `You are an expert immigration document classifier specializing in ${visaType} visa petitions. Your task is to analyze documents and classify them according to USCIS criteria.

## Visa Type: ${criteria.name}
## Requirement: ${criteria.requirement || 'Meet required criteria with strong evidence.'}

## CRITERIA REFERENCE (with document types and evidence strength):

${criteriaList}

## Document Being Analyzed
**Current Label:** ${documentLabel || 'Not provided'}

**Document Content:**
${truncatedText}

## Your Task:
1. Carefully analyze the document content
2. Match it to the MOST APPROPRIATE criterion based on:
   - What USCIS wants for that criterion
   - The document types that support that criterion
   - The evidence strength (strong/medium/weak)
3. If the document could support multiple criteria, choose the PRIMARY one
4. Assess evidence strength (strong/medium/weak)
5. Suggest a professional exhibit label

## Response Format (JSON only):
{
  "criterion_id": "the criterion id (e.g., 'awards', 'judging', 'critical_role') or null if doesn't fit any O-1 criterion",
  "criterion_name": "full name of the criterion",
  "confidence": 0.0-1.0,
  "evidence_strength": "strong" | "medium" | "weak",
  "reasoning": "2-3 sentence explanation of why this classification and evidence strength",
  "suggested_label": "Professional exhibit label (e.g., 'Award Certificate - IEEE Best Paper 2023')",
  "document_type": "Specific document type (e.g., 'Award Certificate', 'Peer Review Confirmation', 'Employment Verification Letter')",
  "secondary_criteria": ["other criteria this might partially support"],
  "uscis_notes": "Brief note on how this supports the USCIS requirement for this criterion"
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

      // Add criterion details from our RAG data
      let criterionDetails = null;
      if (result.criterion_id) {
        const criterion = criteria.criteria.find(c => c.id === result.criterion_id);
        if (criterion) {
          criterionDetails = {
            name: criterion.name,
            description: criterion.description,
            uscisWants: criterion.uscisWants || null,
            timeline: criterion.timeline || null,
            documentTypes: criterion.documentTypes || criterion.examples,
          };
        }
      }

      return {
        success: true,
        ...result,
        visaType,
        criterionDetails,
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

  // Based on IGTA RAG data: 3+ criteria required, recommend 5-6 for strong application
  // 85%+ score = Ready to file, 60-84% = Development needed

  if (strongCount >= 3) {
    // Ready to file (equivalent to 85%+ score)
    return {
      status: 'ready',
      score: 85,
      message: `Strong case with ${strongCount} well-documented criteria. Ready for filing consideration.`,
      recommendation: 'Consider O-1 Ready Filing program - can file within 30 days.',
      nextSteps: strongCount < 5
        ? [`Optionally strengthen additional criteria for even stronger case: ${weak.slice(0, 2).map(w => w.name).join(', ')}`]
        : ['Proceed with petition preparation', 'Gather recommendation letters']
    };
  } else if (strongCount >= 2 && weakCount >= 1) {
    // Almost ready (70-84% range)
    return {
      status: 'almost_ready',
      score: 75,
      message: `Good progress with ${strongCount} strong criteria. Need to strengthen ${weak.length} more.`,
      recommendation: 'Profile Builder Elite recommended - 6-12 month timeline.',
      nextSteps: [
        `Strengthen ${weak.slice(0, 2).map(w => w.name).join(' and ')} with more documents`,
        `Timeline for ${weak[0]?.name}: ${weak[0]?.timeline || '2-4 months'}`,
        'Consider adding documents for missing criteria as backup'
      ]
    };
  } else if (strongCount >= 1 || weakCount >= 2) {
    // Building phase (60-70% range)
    return {
      status: 'building',
      score: 65,
      message: `Foundation started with ${strongCount + weakCount} criteria showing evidence. Need more documentation.`,
      recommendation: 'Profile Builder or Filing Accelerator recommended - 12 month program.',
      nextSteps: [
        `Priority criteria to build: ${weak.concat(missing).slice(0, 3).map(c => c.name).join(', ')}`,
        'Focus on easiest wins first: Scholarly Articles (month 1), Published Material (2-4 months)',
        `Consider ${missing.slice(0, 2).map(m => `${m.name} (${m.timeline || 'varies'})`).join(', ')}`
      ]
    };
  } else {
    // Early stage (below 60%)
    return {
      status: 'early_stage',
      score: 40,
      message: `Early stage - limited evidence for O-1 criteria currently.`,
      recommendation: 'Profile Builder recommended - 12+ month timeline for systematic evidence building.',
      nextSteps: [
        'Start with Scholarly Articles - can begin month 1',
        `Build toward 3+ criteria. Priority: ${missing.slice(0, 3).map(c => c.name).join(', ')}`,
        'Consider Awards & Recognition (3-6 months) and Membership (2-6 months) as achievable goals',
        'Original Contributions and Critical Role build over time through work'
      ]
    };
  }
}

/**
 * Get document types that support a specific criterion
 */
function getDocumentTypesForCriterion(visaType, criterionId) {
  const visa = VISA_CRITERIA[visaType];
  if (!visa) return null;

  const criterion = visa.criteria.find(c => c.id === criterionId);
  if (!criterion) return null;

  return {
    criterion: criterion.name,
    documentTypes: criterion.documentTypes || criterion.examples,
    evidenceStrength: criterion.evidenceStrength || null,
    timeline: criterion.timeline || null,
    uscisWants: criterion.uscisWants || criterion.description
  };
}

/**
 * Get all document type mappings
 */
function getDocumentTypeMap() {
  return DOCUMENT_TYPE_MAP;
}

/**
 * Suggest exhibit organization order based on visa type best practices
 */
function suggestExhibitOrder(classifiedDocuments, visaType) {
  const criteria = VISA_CRITERIA[visaType];
  if (!criteria) return classifiedDocuments;

  // Group documents by criterion
  const grouped = {};
  const unclassified = [];

  for (const doc of classifiedDocuments) {
    if (doc.criterion_id) {
      if (!grouped[doc.criterion_id]) {
        grouped[doc.criterion_id] = [];
      }
      grouped[doc.criterion_id].push(doc);
    } else {
      unclassified.push(doc);
    }
  }

  // Order criteria by strength (most documents first) and then by standard order
  const criteriaOrder = criteria.criteria.map(c => c.id);
  const sortedCriteria = criteriaOrder
    .filter(id => grouped[id] && grouped[id].length > 0)
    .sort((a, b) => (grouped[b]?.length || 0) - (grouped[a]?.length || 0));

  // Build ordered list
  const ordered = [];
  let exhibitNumber = 1;

  for (const criterionId of sortedCriteria) {
    const criterion = criteria.criteria.find(c => c.id === criterionId);
    const docs = grouped[criterionId];

    // Sort documents within criterion by evidence strength
    docs.sort((a, b) => {
      const strengthOrder = { strong: 0, medium: 1, weak: 2 };
      return (strengthOrder[a.evidence_strength] || 1) - (strengthOrder[b.evidence_strength] || 1);
    });

    for (const doc of docs) {
      ordered.push({
        ...doc,
        suggestedExhibitNumber: exhibitNumber++,
        criterionGroup: criterion?.name || 'Unknown',
      });
    }
  }

  // Add unclassified at the end
  for (const doc of unclassified) {
    ordered.push({
      ...doc,
      suggestedExhibitNumber: exhibitNumber++,
      criterionGroup: 'Supporting Documents',
    });
  }

  return ordered;
}

/**
 * Generate exhibit summary report
 */
function generateExhibitSummary(classifiedDocuments, visaType) {
  const criteria = VISA_CRITERIA[visaType];
  if (!criteria) return null;

  const summary = {
    visaType,
    visaName: criteria.name,
    requirement: criteria.requirement,
    totalExhibits: classifiedDocuments.length,
    criteriaBreakdown: [],
    evidenceStrengthSummary: { strong: 0, medium: 0, weak: 0, unclassified: 0 },
    missingCriteria: [],
    warnings: []
  };

  // Count by criterion
  const criteriaCount = {};
  for (const c of criteria.criteria) {
    criteriaCount[c.id] = { count: 0, strong: 0, medium: 0, weak: 0, documents: [] };
  }

  for (const doc of classifiedDocuments) {
    if (doc.criterion_id && criteriaCount[doc.criterion_id]) {
      criteriaCount[doc.criterion_id].count++;
      criteriaCount[doc.criterion_id].documents.push(doc.suggested_label || doc.originalLabel);

      if (doc.evidence_strength === 'strong') {
        criteriaCount[doc.criterion_id].strong++;
        summary.evidenceStrengthSummary.strong++;
      } else if (doc.evidence_strength === 'medium') {
        criteriaCount[doc.criterion_id].medium++;
        summary.evidenceStrengthSummary.medium++;
      } else if (doc.evidence_strength === 'weak') {
        criteriaCount[doc.criterion_id].weak++;
        summary.evidenceStrengthSummary.weak++;
      }
    } else {
      summary.evidenceStrengthSummary.unclassified++;
    }
  }

  // Build breakdown
  for (const c of criteria.criteria) {
    const data = criteriaCount[c.id];
    const status = data.count === 0 ? 'missing' : (data.count < 3 ? 'weak' : 'strong');

    summary.criteriaBreakdown.push({
      id: c.id,
      name: c.name,
      documentCount: data.count,
      strongEvidence: data.strong,
      mediumEvidence: data.medium,
      weakEvidence: data.weak,
      status,
      documents: data.documents,
      timeline: c.timeline
    });

    if (data.count === 0) {
      summary.missingCriteria.push({
        id: c.id,
        name: c.name,
        timeline: c.timeline,
        suggestedDocuments: c.documentTypes || c.examples
      });
    }
  }

  // Add warnings
  const strongCriteria = summary.criteriaBreakdown.filter(c => c.status === 'strong').length;
  if (strongCriteria < 3) {
    summary.warnings.push(`Only ${strongCriteria} criteria have strong evidence. USCIS requires 3+ criteria for ${visaType}.`);
  }

  if (summary.evidenceStrengthSummary.weak > summary.evidenceStrengthSummary.strong) {
    summary.warnings.push('More weak evidence than strong evidence. Consider adding stronger documentation.');
  }

  return summary;
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
  getDocumentTypesForCriterion,
  getDocumentTypeMap,
  suggestExhibitOrder,
  generateExhibitSummary,
  VISA_CRITERIA,
  DOCUMENT_TYPE_MAP,
  ELIGIBILITY_SCORES,
};
