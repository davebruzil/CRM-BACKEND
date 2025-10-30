const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { body, param, query, validationResult } = require('express-validator');
const mongoSanitize = require('mongo-sanitize');
const { MongoClient, ObjectId } = require('mongodb');
const admin = require('firebase-admin');
const https = require('https');
const http = require('http');
const { URL } = require('url');
const calendarService = require('./calendarService');
require('dotenv').config();

// Initialize Firebase Admin SDK - SECURE VERSION
let firebaseInitialized = false;

// Validate all required Firebase environment variables
const requiredFirebaseVars = {
  FIREBASE_PROJECT_ID: process.env.FIREBASE_PROJECT_ID,
  FIREBASE_PRIVATE_KEY: process.env.FIREBASE_PRIVATE_KEY,
  FIREBASE_CLIENT_EMAIL: process.env.FIREBASE_CLIENT_EMAIL,
  FIREBASE_PRIVATE_KEY_ID: process.env.FIREBASE_PRIVATE_KEY_ID
};

// Check for missing required variables
const missingVars = Object.entries(requiredFirebaseVars)
  .filter(([key, value]) => !value)
  .map(([key]) => key);

if (missingVars.length > 0) {
  console.error('🚨 CRITICAL: Missing required Firebase environment variables:', missingVars.join(', '));
  console.error('🚨 Server cannot start without proper authentication configuration');
  if (process.env.NODE_ENV === 'production') {
    console.error('🚨 PRODUCTION MODE: Exiting due to missing authentication credentials');
    process.exit(1);
  }
} else if (!admin.apps.length) {
  try {
    // Validate Firebase project ID format
    const projectId = process.env.FIREBASE_PROJECT_ID;
    if (!projectId.match(/^[a-z0-9-]{6,30}$/)) {
      throw new Error(`Invalid Firebase project ID format: ${projectId}`);
    }

    // Validate private key format
    const privateKey = process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n');
    if (!privateKey.includes('BEGIN PRIVATE KEY') || !privateKey.includes('END PRIVATE KEY')) {
      throw new Error('Invalid Firebase private key format');
    }

    // Validate client email format
    const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
    if (!clientEmail.includes('@') || !clientEmail.includes('.iam.gserviceaccount.com')) {
      throw new Error('Invalid Firebase client email format');
    }

    const serviceAccount = {
      type: "service_account",
      project_id: projectId,
      private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
      private_key: privateKey,
      client_email: clientEmail,
      client_id: process.env.FIREBASE_CLIENT_ID,
      auth_uri: "https://accounts.google.com/o/oauth2/auth",
      token_uri: "https://oauth2.googleapis.com/token",
      auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
      client_x509_cert_url: `https://www.googleapis.com/robot/v1/metadata/x509/${clientEmail}`
    };
    
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      projectId: projectId
    });
    
    firebaseInitialized = true;
    console.log('✅ Firebase Admin SDK initialized successfully');
    console.log(`✅ Project ID: ${projectId}`);
  } catch (error) {
    console.error('🚨 CRITICAL: Firebase Admin SDK initialization failed:', error.message);
    console.error('🚨 Authentication service will be unavailable');
    
    if (process.env.NODE_ENV === 'production') {
      console.error('🚨 PRODUCTION MODE: Exiting due to authentication failure');
      process.exit(1);
    }
  }
}

const app = express();
const PORT = process.env.PORT || 3001;

// Rate limiting configuration
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: {
    error: 'Too many requests from this IP, please try again later.'
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Stricter rate limiting for authentication-required endpoints
const strictLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 50, // limit each IP to 50 requests per windowMs for API endpoints
  message: {
    error: 'Too many API requests from this IP, please try again later.'
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// MongoDB connection
let db;
let clientsCollection;

const connectMongoDB = async () => {
  try {
    if (!process.env.MONGODB_CONNECTION_STRING) {
      throw new Error('MONGODB_CONNECTION_STRING environment variable is not set');
    }
    
    const client = new MongoClient(process.env.MONGODB_CONNECTION_STRING, {
      serverSelectionTimeoutMS: 5000, // Timeout after 5s instead of 30s
      connectTimeoutMS: 5000,
    });
    await client.connect();
    db = client.db(process.env.DATABASE_NAME || 'inkflow_crm');
    clientsCollection = db.collection(process.env.COLLECTION_NAME || 'clients');
    console.log('✅ Connected to MongoDB Atlas');
  } catch (error) {
    console.error('❌ MongoDB connection error:', error.message);
    console.warn('⚠️ Server will start without database connection');
    // Don't exit in development - let the server start without DB
    if (process.env.NODE_ENV === 'production') {
      process.exit(1);
    }
  }
};

// Security Middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'"],
      imgSrc: ["'self'", "data:", "https:"],
    },
  },
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: "cross-origin" }
}));

// Rate limiting
app.use(limiter);

// CORS configuration - more restrictive
const allowedOrigins = [
  'http://localhost:5173',
  'http://localhost:5174',
  'http://localhost:5175',
  'https://localhost:5173',
  'https://localhost:5174',
  'https://localhost:5175',
  'http://10.0.0.8:5173', // Local network access for mobile testing
  'http://10.0.0.8:3001', // Backend on local network
  'capacitor://localhost', // Capacitor iOS
  'http://localhost', // Capacitor Android
  'ionic://localhost', // Ionic dev server
  process.env.CORS_ORIGIN
].filter(Boolean);

app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) return callback(null, true);
    
    if (allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  maxAge: 86400 // 24 hours
}));

// Body parsing with size limits
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// Sanitize all requests
app.use((req, res, next) => {
  req.body = mongoSanitize(req.body);
  req.query = mongoSanitize(req.query);
  req.params = mongoSanitize(req.params);
  next();
});

// Firebase Authentication Middleware - SECURE VERSION
const authenticateFirebaseToken = async (req, res, next) => {
  // SECURITY: Never bypass authentication in any environment
  if (!firebaseInitialized) {
    console.error('🚨 SECURITY ERROR: Firebase Admin SDK not initialized - authentication required');
    return res.status(503).json({ 
      error: 'Authentication service unavailable',
      message: 'Server misconfiguration - contact administrator'
    });
  }

  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ 
        error: 'Authentication required',
        message: 'Authorization header with Bearer token required'
      });
    }

    const token = authHeader.substring(7);
    
    // Validate token format before attempting verification
    if (!token || token.length < 10) {
      return res.status(401).json({ error: 'Invalid token format' });
    }

    const decodedToken = await admin.auth().verifyIdToken(token);
    
    // Additional security checks
    if (!decodedToken.uid) {
      return res.status(401).json({ error: 'Invalid token payload' });
    }

    req.user = {
      uid: decodedToken.uid,
      email: decodedToken.email,
      email_verified: decodedToken.email_verified,
      auth_time: decodedToken.auth_time
    };
    
    next();
  } catch (error) {
    console.error('Authentication error:', error.code || error.message);
    
    // Provide specific error messages for debugging (without exposing sensitive info)
    let errorMessage = 'Invalid authentication token';
    if (error.code === 'auth/id-token-expired') {
      errorMessage = 'Token expired - please login again';
    } else if (error.code === 'auth/id-token-revoked') {
      errorMessage = 'Token revoked - please login again';
    }
    
    return res.status(401).json({ error: errorMessage });
  }
};

// Input validation helpers
const validateObjectId = (req, res, next) => {
  const { id } = req.params;
  if (!ObjectId.isValid(id)) {
    return res.status(400).json({ error: 'Invalid ID format' });
  }
  next();
};

// Health check endpoint (public)
app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    database: db ? 'Connected' : 'Disconnected',
    timestamp: new Date().toISOString()
  });
});

// Apply strict rate limiting to all API routes
app.use('/api', strictLimiter);

// Image proxy endpoint to bypass CORS restrictions (placed after rate limiter to allow liberal access)
app.get('/proxy-image', [
  query('url').isURL().withMessage('Valid URL is required'),
], async (req, res) => {
  console.log('🖼️ Image proxy request received:', req.query.url);

  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    console.error('❌ Invalid URL:', errors.array());
    return res.status(400).json({ error: 'Invalid image URL', details: errors.array() });
  }

  const imageUrl = req.query.url;
  console.log('🔗 Proxying image from:', imageUrl);

  try {
    // Validate URL is from allowed domains (security)
    const parsedUrl = new URL(imageUrl);
    const allowedDomains = ['wasenderapi.com', 'www.wasenderapi.com'];

    if (!allowedDomains.includes(parsedUrl.hostname)) {
      console.error('❌ Domain not allowed:', parsedUrl.hostname);
      return res.status(403).json({ error: 'Domain not allowed' });
    }

    console.log('✅ Domain allowed, fetching image...');

    // Determine which protocol to use
    const protocol = parsedUrl.protocol === 'https:' ? https : http;

    // Fetch the image
    protocol.get(imageUrl, (imageRes) => {
      console.log('📥 Image response status:', imageRes.statusCode);

      // Check if request was successful
      if (imageRes.statusCode !== 200) {
        console.error('❌ Failed to fetch image, status:', imageRes.statusCode);
        return res.status(imageRes.statusCode).json({
          error: 'Failed to fetch image',
          statusCode: imageRes.statusCode
        });
      }

      // Set appropriate headers
      res.setHeader('Content-Type', imageRes.headers['content-type'] || 'image/jpeg');
      res.setHeader('Cache-Control', 'public, max-age=86400'); // Cache for 24 hours
      res.setHeader('Access-Control-Allow-Origin', '*');

      console.log('✅ Piping image to client...');

      // Pipe the image data to response
      imageRes.pipe(res);
    }).on('error', (error) => {
      console.error('❌ Image proxy error:', error);
      res.status(500).json({ error: 'Failed to fetch image', details: error.message });
    });

  } catch (error) {
    console.error('❌ Image proxy error:', error);
    res.status(500).json({ error: 'Failed to proxy image', details: error.message });
  }
});

// CRUD API Routes for Clients - All routes require authentication

// GET /api/clients - Get all clients
app.get('/api/clients', authenticateFirebaseToken, async (req, res) => {
  try {
    if (!clientsCollection) {
      return res.status(503).json({ error: 'Database not available' });
    }
    
    const clients = await clientsCollection
      .find({})
      .sort({ createdAt: -1 })
      .toArray();
    
    // Helper function to detect placement from Hebrew text
    const detectPlacement = (text) => {
      if (!text) return '';
      const lowerText = text.toLowerCase();
      
      // Hebrew placement mappings
      const placements = {
        'כתף': 'כתף',
        'shoulder': 'כתף', 
        'זרוע': 'זרוע',
        'arm': 'זרוע',
        'יד': 'יד',
        'hand': 'יד',
        'גב': 'גב',
        'back': 'גב',
        'רגל': 'רגל',
        'leg': 'רגל',
        'קרסול': 'קרסול',
        'ankle': 'קרסול',
        'צוואר': 'צוואר',
        'neck': 'צוואר',
        'חזה': 'חזה',
        'chest': 'חזה'
      };
      
      for (const [key, value] of Object.entries(placements)) {
        if (lowerText.includes(key)) {
          return value;
        }
      }
      
      return '';
    };

    // Transform MongoDB _id and normalize field names to match frontend expectations
    const transformedClients = clients.map(client => {
      const ideaSummary = client.ideaSummary || client.idea_summary || '';
      const detectedPlacement = detectPlacement(ideaSummary);

      return {
        ...client,
        id: client._id.toString(),
        // Normalize field names from different sources (n8n vs manual)
        name: client.name || 'Unknown',
        phone: client.phone || client.phone_number || '',
        meetingType: client.meetingType || client.meeting_type || 'consultation',
        ideaSummary: ideaSummary,
        tattooDescription: client.tattooDescription || ideaSummary,
        placement: client.placement || detectedPlacement,
        aiActive: client.aiActive || client.ai_active || 'pending',
        status: client.status || 'Consultation',
        // Map images field to referencePhotos for frontend compatibility
        referencePhotos: client.referencePhotos || client.images || [],
        createdAt: client.createdAt ? new Date(client.createdAt) : (client.timestamp ? new Date(client.timestamp) : new Date()),
        updatedAt: client.updatedAt ? new Date(client.updatedAt) : (client.updated_at ? new Date(client.updated_at) : new Date())
      };
    });
    
    res.json(transformedClients);
  } catch (error) {
    console.error('Error fetching clients:', error.message);
    res.status(500).json({ error: 'Failed to fetch clients' });
  }
});

// POST /api/clients - Create new client
app.post('/api/clients', [
  authenticateFirebaseToken,
  body('name').trim().isLength({ min: 1, max: 100 }).escape().withMessage('Name is required and must be between 1-100 characters'),
  body('phone').trim().isMobilePhone().withMessage('Valid phone number is required'),
  body('email').optional().isEmail().normalizeEmail().withMessage('Must be a valid email'),
  body('meetingType').optional().isIn(['consultation', 'appointment', 'follow-up']).withMessage('Invalid meeting type'),
  body('ideaSummary').optional().trim().isLength({ max: 1000 }).escape().withMessage('Idea summary must be less than 1000 characters'),
  body('tattooDescription').optional().trim().isLength({ max: 1000 }).escape().withMessage('Tattoo description must be less than 1000 characters'),
  body('placement').optional().trim().isLength({ max: 100 }).escape().withMessage('Placement must be less than 100 characters'),
  body('size').optional().trim().isLength({ max: 50 }).escape().withMessage('Size must be less than 50 characters'),
  body('budget').optional().trim().isLength({ max: 100 }).escape().withMessage('Budget must be less than 100 characters'),
  body('status').optional().isIn(['Consultation', 'Consultation Scheduled', 'In Progress', 'Completed', 'Cancelled']).withMessage('Invalid status'),
  body('aiActive').optional().isIn(['pending', 'in_progress', 'completed']).withMessage('Invalid AI status')
], async (req, res) => {
  // Check validation results
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ 
      error: 'Validation failed', 
      details: errors.array() 
    });
  }
  try {
    if (!clientsCollection) {
      return res.status(503).json({ error: 'Database not available' });
    }
    
    const now = new Date();
    const newClient = {
      ...req.body,
      createdAt: now,
      updatedAt: now
    };

    // Check for duplicate phone number using parameterized query
    const existingClient = await clientsCollection.findOne({ 
      phone: { $eq: newClient.phone } 
    });
    if (existingClient) {
      return res.status(400).json({ error: 'A client with this phone number already exists' });
    }

    const result = await clientsCollection.insertOne(newClient);
    const insertedClient = {
      ...newClient,
      _id: result.insertedId,
      id: result.insertedId.toString()
    };

    res.status(201).json(insertedClient);
  } catch (error) {
    console.error('Error creating client:', error.message);
    res.status(500).json({ error: 'Failed to create client' });
  }
});

// PUT /api/clients/:id - Update client
app.put('/api/clients/:id', [
  authenticateFirebaseToken,
  validateObjectId,
  body('name').optional().trim().isLength({ min: 1, max: 100 }).escape().withMessage('Name must be between 1-100 characters'),
  body('phone').optional().trim().isMobilePhone().withMessage('Must be a valid phone number'),
  body('email').optional().isEmail().normalizeEmail().withMessage('Must be a valid email'),
  body('meetingType').optional().isIn(['consultation', 'appointment', 'follow-up']).withMessage('Invalid meeting type'),
  body('ideaSummary').optional().trim().isLength({ max: 1000 }).escape().withMessage('Idea summary must be less than 1000 characters'),
  body('tattooDescription').optional().trim().isLength({ max: 1000 }).escape().withMessage('Tattoo description must be less than 1000 characters'),
  body('placement').optional().trim().isLength({ max: 100 }).escape().withMessage('Placement must be less than 100 characters'),
  body('size').optional().trim().isLength({ max: 50 }).escape().withMessage('Size must be less than 50 characters'),
  body('budget').optional().trim().isLength({ max: 100 }).escape().withMessage('Budget must be less than 100 characters'),
  body('status').optional().isIn(['Consultation', 'Consultation Scheduled', 'In Progress', 'Completed', 'Cancelled']).withMessage('Invalid status'),
  body('aiActive').optional().isIn(['pending', 'in_progress', 'completed']).withMessage('Invalid AI status')
], async (req, res) => {
  // Check validation results
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ 
      error: 'Validation failed', 
      details: errors.array() 
    });
  }
  try {
    if (!clientsCollection) {
      return res.status(503).json({ error: 'Database not available' });
    }
    
    const { id } = req.params;
    const updateData = {
      ...req.body,
      updatedAt: new Date()
    };

    // Remove _id and id from updates
    delete updateData._id;
    delete updateData.id;

    const result = await clientsCollection.updateOne(
      { _id: { $eq: new ObjectId(id) } },
      { $set: updateData }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({ error: 'Client not found' });
    }

    // Fetch and return updated client
    const updatedClient = await clientsCollection.findOne({ 
      _id: { $eq: new ObjectId(id) } 
    });
    res.json({
      ...updatedClient,
      id: updatedClient._id.toString()
    });
  } catch (error) {
    console.error('Error updating client:', error.message);
    res.status(500).json({ error: 'Failed to update client' });
  }
});

// DELETE /api/clients/:id - Delete client
app.delete('/api/clients/:id', [
  authenticateFirebaseToken,
  validateObjectId
], async (req, res) => {
  try {
    if (!clientsCollection) {
      return res.status(503).json({ error: 'Database not available' });
    }
    
    const { id } = req.params;
    const result = await clientsCollection.deleteOne({ 
      _id: { $eq: new ObjectId(id) } 
    });

    if (result.deletedCount === 0) {
      return res.status(404).json({ error: 'Client not found' });
    }

    res.json({ message: 'Client deleted successfully' });
  } catch (error) {
    console.error('Error deleting client:', error.message);
    res.status(500).json({ error: 'Failed to delete client' });
  }
});

// GET /api/clients/search?q= - Search clients
app.get('/api/clients/search', [
  authenticateFirebaseToken,
  query('q').trim().isLength({ min: 1, max: 100 }).escape().withMessage('Search query is required and must be between 1-100 characters')
], async (req, res) => {
  // Check validation results
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ 
      error: 'Validation failed', 
      details: errors.array() 
    });
  }
  try {
    if (!clientsCollection) {
      return res.status(503).json({ error: 'Database not available' });
    }
    
    const { q } = req.query;
    
    // Escape regex special characters to prevent ReDoS attacks
    const escapedQuery = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    
    const clients = await clientsCollection
      .find({
        $or: [
          { name: { $regex: new RegExp(escapedQuery, 'i') } },
          { phone: { $regex: new RegExp(escapedQuery, 'i') } },
          { email: { $regex: new RegExp(escapedQuery, 'i') } }
        ]
      })
      .sort({ createdAt: -1 })
      .toArray();

    const transformedClients = clients.map(client => ({
      ...client,
      id: client._id.toString()
    }));

    res.json(transformedClients);
  } catch (error) {
    console.error('Error searching clients:', error.message);
    res.status(500).json({ error: 'Failed to search clients' });
  }
});

// ==================== GOOGLE CALENDAR API ROUTES ====================

// GET /api/calendar/auth - Get OAuth2 authorization URL (public for initial setup)
app.get('/api/calendar/auth', (req, res) => {
  try {
    const authUrl = calendarService.getAuthUrl();
    res.json({ authUrl });
  } catch (error) {
    console.error('Error generating auth URL:', error);
    res.status(500).json({ error: 'Failed to generate authorization URL' });
  }
});

// GET /api/calendar/oauth2callback - OAuth2 callback endpoint
app.get('/api/calendar/oauth2callback', async (req, res) => {
  try {
    const { code } = req.query;

    if (!code) {
      return res.status(400).json({ error: 'Authorization code is required' });
    }

    const tokens = await calendarService.getTokenFromCode(code);

    // In production, store these tokens securely in the database
    // For now, return them to be stored in .env
    res.json({
      message: 'Authorization successful! Please save the refresh_token to your .env file.',
      refresh_token: tokens.refresh_token,
      instructions: 'Add GOOGLE_REFRESH_TOKEN to your .env file'
    });
  } catch (error) {
    console.error('Error in OAuth callback:', error);
    res.status(500).json({ error: 'Authorization failed' });
  }
});

// POST /api/calendar/events - Create a new calendar event
app.post('/api/calendar/events', [
  authenticateFirebaseToken,
  body('summary').trim().isLength({ min: 1, max: 200 }).withMessage('Event title is required'),
  body('description').optional().trim().isLength({ max: 1000 }),
  body('startDateTime').isISO8601().withMessage('Valid start date-time is required'),
  body('endDateTime').isISO8601().withMessage('Valid end date-time is required'),
  body('location').optional().trim().isLength({ max: 200 }),
  body('attendees').optional().isArray(),
  body('clientId').optional().trim()
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      error: 'Validation failed',
      details: errors.array()
    });
  }

  try {
    const { summary, description, startDateTime, endDateTime, location, attendees, clientId } = req.body;

    // Check availability first
    const isAvailable = await calendarService.checkAvailability(startDateTime, endDateTime);
    if (!isAvailable) {
      return res.status(409).json({
        error: 'Time slot is not available',
        message: 'There is already an appointment scheduled during this time'
      });
    }

    // Create the event
    const event = await calendarService.createEvent({
      summary,
      description,
      startDateTime,
      endDateTime,
      location,
      attendees
    });

    // If clientId is provided, update the client with the event ID
    if (clientId && clientsCollection) {
      await clientsCollection.updateOne(
        { _id: { $eq: new ObjectId(clientId) } },
        {
          $set: {
            calendarEventId: event.id,
            calendarEventLink: event.htmlLink,
            consultationDate: startDateTime,
            updatedAt: new Date()
          }
        }
      );
    }

    res.status(201).json({
      message: 'Calendar event created successfully',
      event: {
        id: event.id,
        summary: event.summary,
        startDateTime: event.start.dateTime,
        endDateTime: event.end.dateTime,
        htmlLink: event.htmlLink
      }
    });
  } catch (error) {
    console.error('Error creating calendar event:', error);
    res.status(500).json({ error: 'Failed to create calendar event' });
  }
});

// GET /api/calendar/events/:eventId - Get a specific calendar event
app.get('/api/calendar/events/:eventId', authenticateFirebaseToken, async (req, res) => {
  try {
    const { eventId } = req.params;
    const event = await calendarService.getEvent(eventId);

    res.json({
      id: event.id,
      summary: event.summary,
      description: event.description,
      startDateTime: event.start.dateTime,
      endDateTime: event.end.dateTime,
      location: event.location,
      htmlLink: event.htmlLink,
      status: event.status
    });
  } catch (error) {
    console.error('Error getting calendar event:', error);
    if (error.code === 404) {
      return res.status(404).json({ error: 'Event not found' });
    }
    res.status(500).json({ error: 'Failed to get calendar event' });
  }
});

// PUT /api/calendar/events/:eventId - Update a calendar event
app.put('/api/calendar/events/:eventId', [
  authenticateFirebaseToken,
  body('summary').optional().trim().isLength({ min: 1, max: 200 }),
  body('description').optional().trim().isLength({ max: 1000 }),
  body('startDateTime').optional().isISO8601(),
  body('endDateTime').optional().isISO8601(),
  body('location').optional().trim().isLength({ max: 200 }),
  body('attendees').optional().isArray()
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      error: 'Validation failed',
      details: errors.array()
    });
  }

  try {
    const { eventId } = req.params;
    const updateData = req.body;

    // If updating time, check availability
    if (updateData.startDateTime && updateData.endDateTime) {
      const isAvailable = await calendarService.checkAvailability(
        updateData.startDateTime,
        updateData.endDateTime
      );

      if (!isAvailable) {
        return res.status(409).json({
          error: 'Time slot is not available',
          message: 'There is already an appointment scheduled during this time'
        });
      }
    }

    const event = await calendarService.updateEvent(eventId, updateData);

    res.json({
      message: 'Calendar event updated successfully',
      event: {
        id: event.id,
        summary: event.summary,
        startDateTime: event.start.dateTime,
        endDateTime: event.end.dateTime,
        htmlLink: event.htmlLink
      }
    });
  } catch (error) {
    console.error('Error updating calendar event:', error);
    if (error.code === 404) {
      return res.status(404).json({ error: 'Event not found' });
    }
    res.status(500).json({ error: 'Failed to update calendar event' });
  }
});

// DELETE /api/calendar/events/:eventId - Delete a calendar event
app.delete('/api/calendar/events/:eventId', [
  authenticateFirebaseToken,
  body('clientId').optional().trim()
], async (req, res) => {
  try {
    const { eventId } = req.params;
    const { clientId } = req.body;

    await calendarService.deleteEvent(eventId);

    // If clientId is provided, remove the event ID from the client
    if (clientId && clientsCollection) {
      await clientsCollection.updateOne(
        { _id: { $eq: new ObjectId(clientId) } },
        {
          $unset: {
            calendarEventId: '',
            calendarEventLink: ''
          },
          $set: {
            updatedAt: new Date()
          }
        }
      );
    }

    res.json({ message: 'Calendar event deleted successfully' });
  } catch (error) {
    console.error('Error deleting calendar event:', error);
    if (error.code === 404) {
      return res.status(404).json({ error: 'Event not found' });
    }
    res.status(500).json({ error: 'Failed to delete calendar event' });
  }
});

// GET /api/calendar/events - List upcoming calendar events
app.get('/api/calendar/events', authenticateFirebaseToken, async (req, res) => {
  try {
    const maxResults = parseInt(req.query.maxResults) || 10;
    const events = await calendarService.listUpcomingEvents(maxResults);

    const formattedEvents = events.map(event => ({
      id: event.id,
      summary: event.summary,
      description: event.description,
      startDateTime: event.start.dateTime || event.start.date,
      endDateTime: event.end.dateTime || event.end.date,
      location: event.location,
      htmlLink: event.htmlLink,
      status: event.status
    }));

    res.json(formattedEvents);
  } catch (error) {
    console.error('Error listing calendar events:', error);
    res.status(500).json({ error: 'Failed to list calendar events' });
  }
});

// POST /api/calendar/check-availability - Check if a time slot is available
app.post('/api/calendar/check-availability', [
  authenticateFirebaseToken,
  body('startDateTime').isISO8601().withMessage('Valid start date-time is required'),
  body('endDateTime').isISO8601().withMessage('Valid end date-time is required')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      error: 'Validation failed',
      details: errors.array()
    });
  }

  try {
    const { startDateTime, endDateTime } = req.body;
    const isAvailable = await calendarService.checkAvailability(startDateTime, endDateTime);

    res.json({
      available: isAvailable,
      message: isAvailable
        ? 'Time slot is available'
        : 'Time slot is already booked'
    });
  } catch (error) {
    console.error('Error checking availability:', error);
    res.status(500).json({ error: 'Failed to check availability' });
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err.message);
  res.status(500).json({ error: 'Internal server error' });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down gracefully');
  process.exit(0);
});

// Start server
const startServer = async () => {
  try {
    await connectMongoDB();
    
    app.listen(PORT, () => {
      console.log(`🚀 INKFLOW CRM Backend running on http://localhost:${PORT}`);
      console.log(`📊 Database: ${process.env.DATABASE_NAME}`);
      console.log(`🔗 CORS Origins: ${allowedOrigins.join(', ')}`);
      console.log(`🔒 Security: Authentication, Rate limiting, Input validation enabled`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
};

startServer();