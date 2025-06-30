const dotenv = require("dotenv");
dotenv.config();
const express = require("express");
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
var admin = require("firebase-admin");

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
  },
});

// FB service account
const serviceAccountString = Buffer.from(process.env.FB_KEY, "base64").toString(
  "utf8"
);
const serviceAccount = JSON.parse(serviceAccountString);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

async function run() {
  try {
    // Connect the client to the server	(optional starting in v4.7)
    await client.connect();

    const parcelsCollection = client
      .db("ParcelsCollection")
      .collection("parcels");
    const paymentCollection = client
      .db("ParcelsCollection")
      .collection("payment");
    const usersCollection = client.db("ParcelsCollection").collection("users");
    const ridersCollection = client
      .db("ParcelsCollection")
      .collection("riders");

    const verifyToken = async (req, res, next) => {
      const authHeaders = req.headers.authorization;

      if (!authHeaders || !authHeaders.startsWith("Bearer ")) {
        return res
          .status(401)
          .json({
            message: "Unauthorized: No or invalid Authorization header",
          });
      }

      const token = authHeaders.split(" ")[1];

      try {
        const decoded = await admin.auth().verifyIdToken(token);
        req.decoded = decoded;
        next();
      } catch (error) {
        return res
          .status(401)
          .json({ message: "Unauthorized: Invalid or expired token" });
      }
    };

    const verifyTokenEmail = async (req, res, next) => {
      if (req?.query?.email !== req.decoded?.email) {
        return res
          .status(403)
          .json({ message: "Forbidden: Email does not match token" });
      }
      next();
    };

    app.get("/", (req, res) => {
      res.send("🚀 QuickDrop API is running");
    });

    // Get all parcels OR filter by user email
    app.get("/parcels", verifyToken, verifyTokenEmail, async (req, res) => {
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
        const parcel = await parcelsCollection.findOne({
          _id: new ObjectId(id),
        });
        if (!parcel) {
          return res.status(404).json({ error: "Parcel not found" });
        }
        res.json(parcel); // ✅ Success response
      } catch (err) {
        res.status(500).json({ error: "Server error" });
      }
    });

    // [GET] /payments?email=user@example.com
    app.get("/payments", verifyToken, verifyTokenEmail, async (req, res) => {
      const email = req.query.email;
      if (!email) return res.status(400).send({ error: "Email is required" });

      const payments = await paymentCollection
        .find({ email })
        .sort({
          paid_date: -1,
        })
        .toArray();

      res.send(payments);
    });

    // Get all pending riders
    app.get("/riders/pending", async (req, res) => {
      try {
        const riders = await ridersCollection
          .find({ status: "pending" })
          .toArray();
        res.send(riders);
      } catch (err) {
        res.status(500).send({ error: "Failed to fetch pending riders" });
      }
    });

    // Get all approved riders
    app.get("/riders/approved", async (req, res) => {
      try {
        const approvedRiders = await ridersCollection
          .find({ status: "active" })
          .toArray();     
        res.send(approvedRiders);
      } catch (error) {
        res.status(500).send({ error: "Failed to fetch approved riders" });
      }
    });

    // Save parcels to the mongodb
    app.post(
      "/add-parcels",
      verifyToken,
      verifyTokenEmail,
      async (req, res) => {
        const data = req.body;
        const result = await parcelsCollection.insertOne(data);
        res.send(result);
      }
    );

    // Creating payment intent for stripe
    app.post(
      "/createPaymentIntent",
      verifyToken,
      verifyTokenEmail,
      async (req, res) => {
        const { amount } = req.body;
        const parsedAmount = parseFloat(amount);
        try {
          const paymentIntent = await stripe.paymentIntents.create({
            amount: parsedAmount * 100,
            currency: "bdt",
            payment_method_types: ["card"],
          });
          res.send({ clientSecret: paymentIntent.client_secret });
        } catch (error) {
          res.status(500).send({ error: error.message });
        }
      }
    );

    // Creating users
    app.post("/users", async (req, res) => {
      const users = req.body;
      const result = await usersCollection.insertOne(users);
      res.send(result);
    });

    // Add rider form data to MongoDB
    app.post("/riders", async (req, res) => {
      const rider = req.body;

      try {
        rider.status = "pending";
        const result = await ridersCollection.insertOne(rider);
        res.send(result);
      } catch (error) {
        console.error("Failed to insert rider:", error);
        res.status(500).send({ error: "Internal server error" });
      }
    });

    app.post("/payments", verifyToken, verifyTokenEmail, async (req, res) => {
      const payment = req.body;

      try {
        // 1. Insert payment info in payments collection
        const result = await paymentCollection.insertOne(payment);

        // 2. Update the related parcel as "paid"
        const updateParcel = await parcelsCollection.updateOne(
          { _id: new ObjectId(payment.parcelId) },
          {
            $set: {
              payment_status: "paid",
              transactionId: payment.transactionId,
            },
          }
        );

        res.send({ insertResult: result, updateResult: updateParcel });
      } catch (err) {
        res.status(500).send({ error: err.message });
      }
    });

    // Approve a rider (update status to "active")
    app.patch("/riders/approve/:id", async (req, res) => {
      const id = req.params.id;
      const riderEmail = req.body.email;
      try {
        const result = await ridersCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: { status: "active" } }
        );

        let roleResult = {};
        if(result.modifiedCount > 0 && riderEmail){
            const userEmail = { email : riderEmail};
            const updateUserRole = {
                $set:{role: "rider"}
            }
            const roleResult = await usersCollection.updateOne(userEmail, updateUserRole)
        }
        res.send({ result, roleResult });
      } catch (err) {
        res.status(500).send({ error: "Failed to approve rider" });
      }
    });

    // Delete parcel by ID
    app.delete("/delete-parcel/:id", async (req, res) => {
      const id = req.params.id;
      const result = await parcelsCollection.deleteOne({
        _id: new ObjectId(id),
      });
      res.send(result);
    });

    // Delete rider
    app.delete("/riders/:id", async (req, res) => {
      const id = req.params.id;
      try {
        const result = await ridersCollection.deleteOne({
          _id: new ObjectId(id),
        });
        res.send(result);
      } catch (err) {
        res.status(500).send({ error: "Failed to delete rider" });
      }
    });

    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!"
    );
  } finally {
  }
}
run().catch(console.dir);

// Start Server
app.listen(port, () => {
  console.log(`🚀 Server is running at ${port}`);
});
