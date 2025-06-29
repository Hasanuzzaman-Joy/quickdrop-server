const dotenv = require('dotenv');
dotenv.config();
const express = require('express');
const cors = require('cors');
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

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
        const paymentCollection = client.db("ParcelsCollection").collection("payment")

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

        // Get single parcel details
        app.get("/parcel/:id", async (req, res) => {
            const { id } = req.params;

            // ✅ Check if ID is valid MongoDB ObjectId
            if (!ObjectId.isValid(id)) {
                return res.status(400).json({ error: "Invalid parcel ID" });
            }

            try {
                const parcel = await parcelsCollection.findOne({ _id: new ObjectId(id) });
                if (!parcel) {
                    return res.status(404).json({ error: "Parcel not found" });
                }
                res.json(parcel); // ✅ Success response
            }
            catch (err) {
                res.status(500).json({ error: "Server error" });
            }
        });


        // [GET] /payments?email=user@example.com
        app.get("/payments", async (req, res) => {
            const email = req.query.email;
            if (!email) return res.status(400).send({ error: "Email is required" });

            const payments = await paymentCollection
                .find({ email })
                .sort({
                    paid_date: -1
                })
                .toArray();

            res.send(payments);
        });


        // Save parcels to the mongodb
        app.post("/add-parcels", async (req, res) => {
            const data = req.body;
            const result = await parcelsCollection.insertOne(data);
            res.send(result);
        })

        // Creating payment intent for stripe
        app.post("/createPaymentIntent", async (req, res) => {
            const { amount } = req.body;
            const parsedAmount = parseFloat(amount);
            try {
                const paymentIntent = await stripe.paymentIntents.create({
                    amount: parsedAmount * 100,
                    currency: 'bdt',
                    payment_method_types: ['card'],
                });
                res.send({ clientSecret: paymentIntent.client_secret });
            }
            catch (error) {
                res.status(500).send({ error: error.message });
            }
        })


        app.post("/payments", async (req, res) => {
            const payment = req.body;

            try {
                // 1. Insert payment info in payments collection
                const result = await paymentCollection.insertOne(payment);

                // 2. Update the related parcel as "paid"
                const updateParcel = await parcelsCollection.updateOne(
                    { _id: new ObjectId(payment.parcelId) },
                    { $set: { payment_status: "paid", transactionId: payment.transactionId } }
                );

                res.send({ insertResult: result, updateResult: updateParcel });
            }
            catch (err) {
                res.status(500).send({ error: err.message });
            }
        });


        // Delete parcel by ID
        app.delete("/delete-parcel/:id", async (req, res) => {
            const id = req.params.id;
            const result = await parcelsCollection.deleteOne({ _id: new ObjectId(id) });
            res.send(result)
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
