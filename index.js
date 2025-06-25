const dotenv = require('dotenv');
dotenv.config();
const express = require('express');
const cors = require('cors');
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// MongoDB Connection
const uri = process.env.DB_URI;

const client = new MongoClient(uri, {
    serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
    }
});

async function run() {
    try {
        // Connect the client to the server	(optional starting in v4.7)
        await client.connect();

        const parcelsCollection = client.db("ParcelsCollection").collection("parcels")

        app.get('/', (req, res) => {
            res.send('🚀 QuickDrop API is running');
        });

        // Get all parcels OR filter by user email
        app.get("/parcels", async (req, res) => {
            const userEmail = req.query.email;

            let query = {};
            if (userEmail) {
                query = { sender: userEmail };
            }

            const parcels = await parcelsCollection.find(query).toArray();
            res.send(parcels);
        });

        // Save parcels to the mongodb
        app.post("/add-parcels", async (req, res) => {
            const data = req.body;
            const result = await parcelsCollection.insertOne(data);
            res.send(result);
        })

        // Delete parcel by ID
        app.delete("/delete-parcel/:id", async (req, res) => {
            const id = req.params.id;
            const result = await parcelsCollection.deleteOne({ _id: new ObjectId(id) });
        });

        await client.db("admin").command({ ping: 1 });
        console.log("Pinged your deployment. You successfully connected to MongoDB!");
    }
    finally {
    }
}
run().catch(console.dir);

// Start Server
app.listen(port, () => {
    console.log(`🚀 Server is running at ${port}`);
});
