const { MongoClient } = require('mongodb');
require('dotenv').config();

async function checkImages() {
  const client = new MongoClient(process.env.MONGODB_URI);

  try {
    await client.connect();
    console.log('Connected to MongoDB');

    const db = client.db('inkflow_crm');
    const clientDoc = await db.collection('clients').findOne({});

    if (clientDoc) {
      console.log('\n=== CLIENT DOCUMENT ===');
      console.log('Name:', clientDoc.name);
      console.log('\n=== IMAGES FIELD ===');
      console.log(JSON.stringify(clientDoc.images, null, 2));
      console.log('\n=== REFERENCE PHOTOS FIELD ===');
      console.log(JSON.stringify(clientDoc.referencePhotos, null, 2));
    } else {
      console.log('No clients found');
    }
  } catch (error) {
    console.error('Error:', error);
  } finally {
    await client.close();
  }
}

checkImages();
