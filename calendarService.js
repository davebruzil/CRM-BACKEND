const { google } = require('googleapis');
require('dotenv').config();

class CalendarService {
  constructor() {
    this.oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3001/api/calendar/oauth2callback'
    );

    // Set credentials if refresh token is available
    if (process.env.GOOGLE_REFRESH_TOKEN) {
      this.oauth2Client.setCredentials({
        refresh_token: process.env.GOOGLE_REFRESH_TOKEN
      });
    }

    this.calendar = google.calendar({ version: 'v3', auth: this.oauth2Client });
  }

  /**
   * Generate OAuth2 URL for user authorization
   * @returns {string} Authorization URL
   */
  getAuthUrl() {
    const scopes = [
      'https://www.googleapis.com/auth/calendar',
      'https://www.googleapis.com/auth/calendar.events'
    ];

    return this.oauth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: scopes,
      prompt: 'consent' // Force consent screen to get refresh token
    });
  }

  /**
   * Exchange authorization code for tokens
   * @param {string} code - Authorization code from OAuth callback
   * @returns {Promise<Object>} Token object
   */
  async getTokenFromCode(code) {
    try {
      const { tokens } = await this.oauth2Client.getToken(code);
      this.oauth2Client.setCredentials(tokens);
      return tokens;
    } catch (error) {
      console.error('Error getting tokens:', error);
      throw error;
    }
  }

  /**
   * Set credentials manually (useful for stored tokens)
   * @param {Object} tokens - Token object containing access_token and refresh_token
   */
  setCredentials(tokens) {
    this.oauth2Client.setCredentials(tokens);
  }

  /**
   * Create a calendar event
   * @param {Object} eventDetails - Event details
   * @param {string} eventDetails.summary - Event title
   * @param {string} eventDetails.description - Event description
   * @param {string} eventDetails.startDateTime - ISO 8601 date-time string
   * @param {string} eventDetails.endDateTime - ISO 8601 date-time string
   * @param {string} eventDetails.location - Event location
   * @param {Array} eventDetails.attendees - Array of attendee emails
   * @returns {Promise<Object>} Created event
   */
  async createEvent(eventDetails) {
    try {
      const {
        summary,
        description,
        startDateTime,
        endDateTime,
        location,
        attendees = [],
        timeZone = 'Asia/Jerusalem' // Default to Israel timezone
      } = eventDetails;

      const event = {
        summary,
        description,
        location,
        start: {
          dateTime: startDateTime,
          timeZone
        },
        end: {
          dateTime: endDateTime,
          timeZone
        },
        attendees: attendees.map(email => ({ email })),
        reminders: {
          useDefault: false,
          overrides: [
            { method: 'email', minutes: 24 * 60 }, // 1 day before
            { method: 'popup', minutes: 60 } // 1 hour before
          ]
        },
        colorId: '5' // Banana yellow color for tattoo appointments
      };

      const response = await this.calendar.events.insert({
        calendarId: 'primary',
        resource: event,
        sendUpdates: 'all' // Send email notifications to attendees
      });

      return response.data;
    } catch (error) {
      console.error('Error creating calendar event:', error);
      throw error;
    }
  }

  /**
   * Get a calendar event by ID
   * @param {string} eventId - Event ID
   * @returns {Promise<Object>} Event details
   */
  async getEvent(eventId) {
    try {
      const response = await this.calendar.events.get({
        calendarId: 'primary',
        eventId
      });
      return response.data;
    } catch (error) {
      console.error('Error getting calendar event:', error);
      throw error;
    }
  }

  /**
   * Update a calendar event
   * @param {string} eventId - Event ID to update
   * @param {Object} eventDetails - Updated event details
   * @returns {Promise<Object>} Updated event
   */
  async updateEvent(eventId, eventDetails) {
    try {
      const {
        summary,
        description,
        startDateTime,
        endDateTime,
        location,
        attendees = [],
        timeZone = 'Asia/Jerusalem'
      } = eventDetails;

      const event = {
        summary,
        description,
        location,
        start: {
          dateTime: startDateTime,
          timeZone
        },
        end: {
          dateTime: endDateTime,
          timeZone
        },
        attendees: attendees.map(email => ({ email })),
        reminders: {
          useDefault: false,
          overrides: [
            { method: 'email', minutes: 24 * 60 },
            { method: 'popup', minutes: 60 }
          ]
        }
      };

      const response = await this.calendar.events.update({
        calendarId: 'primary',
        eventId,
        resource: event,
        sendUpdates: 'all'
      });

      return response.data;
    } catch (error) {
      console.error('Error updating calendar event:', error);
      throw error;
    }
  }

  /**
   * Delete a calendar event
   * @param {string} eventId - Event ID to delete
   * @returns {Promise<void>}
   */
  async deleteEvent(eventId) {
    try {
      await this.calendar.events.delete({
        calendarId: 'primary',
        eventId,
        sendUpdates: 'all' // Notify attendees about cancellation
      });
    } catch (error) {
      console.error('Error deleting calendar event:', error);
      throw error;
    }
  }

  /**
   * List upcoming events
   * @param {number} maxResults - Maximum number of events to return
   * @returns {Promise<Array>} Array of events
   */
  async listUpcomingEvents(maxResults = 10) {
    try {
      const response = await this.calendar.events.list({
        calendarId: 'primary',
        timeMin: new Date().toISOString(),
        maxResults,
        singleEvents: true,
        orderBy: 'startTime'
      });

      return response.data.items || [];
    } catch (error) {
      console.error('Error listing calendar events:', error);
      throw error;
    }
  }

  /**
   * Check for conflicts with existing appointments
   * @param {string} startDateTime - ISO 8601 date-time string
   * @param {string} endDateTime - ISO 8601 date-time string
   * @returns {Promise<boolean>} True if time slot is available
   */
  async checkAvailability(startDateTime, endDateTime) {
    try {
      const response = await this.calendar.events.list({
        calendarId: 'primary',
        timeMin: startDateTime,
        timeMax: endDateTime,
        singleEvents: true
      });

      return !response.data.items || response.data.items.length === 0;
    } catch (error) {
      console.error('Error checking availability:', error);
      throw error;
    }
  }
}

module.exports = new CalendarService();
