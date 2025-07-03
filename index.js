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

    // DB Collections
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
    const earningsCollection = client.db("ParcelsCollection").collection("riderEarnings");

    // Custom Middlewares
    const verifyToken = async (req, res, next) => {
      const authHeaders = req.headers.authorization;

      if (!authHeaders || !authHeaders.startsWith("Bearer ")) {
        return res.status(401).json({
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

    const verifyAdmin = async (req, res, next) => {
      try {
        const email = req?.decoded?.email;
        if (!email) {
          return res
            .status(401)
            .json({ message: "Unauthorized: No email found" });
        }

        const user = await usersCollection.findOne(
          { email },
          { projection: { role: 1 } }
        );

        if (user?.role !== "admin") {
          return res.status(403).json({ message: "Forbidden: Admins only" });
        }

        next();
      } catch (error) {
        console.error("Admin verification error:", error);
        res.status(500).json({ message: "Server error" });
      }
    };

    const verifyRider = async (req, res, next) => {
      try {
        const email = req?.decoded?.email;
        if (!email) {
          return res
            .status(401)
            .json({ message: "Unauthorized: No email found" });
        }

        const user = await usersCollection.findOne(
          { email },
          { projection: { role: 1 } }
        );

        if (user?.role !== "rider") {
          return res.status(403).json({ message: "Forbidden: Riders only" });
        }

        next();
      } catch (error) {
        console.error("Rider verification error:", error);
        res.status(500).json({ message: "Server error" });
      }
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

      // Check if ID is valid MongoDB ObjectId
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
        res.json(parcel); // Success response
      } catch (err) {
        res.status(500).json({ error: "Server error" });
      }
    });

    // Get pending deliveries for a specific rider
    app.get("/rider/pending-deliveries", verifyToken, verifyRider, async (req, res) => {
      const email = req.query.email;
      try {
        const deliveries = await parcelsCollection
          .find({
            riderEmail: email,
            delivery_status: { $in: ["rider assigned", "in-transit"] },
          })
          .toArray();
        res.send(deliveries);
      } catch (err) {
        res.status(500).send({ error: "Failed to fetch rider deliveries" });
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

    // get role
    app.get("/user/role/:email", verifyToken, async (req, res) => {
      const email = req.params.email;

      if (!email) {
        return res.status(400).json({ error: "Email parameter is required" });
      }

      try {
        const user = await usersCollection.findOne(
          { email },
          {
            projection: {
              role: 1,
              _id: 0,
            },
          }
        );

        if (!user) {
          return res.status(404).json({ error: "User not found" });
        }

        res.send(user);
      } catch (err) {
        console.error("Error fetching user role:", err);
        res.status(500).json({ error: "Server error" });
      }
    });

    // Search user by email for admin
    app.get("/admin/search", verifyToken, verifyAdmin, async (req, res) => {
      const email = req.query.email;
      if (!email) return res.status(400).send({ error: "Email is required" });

      const user = await usersCollection
        .find({
          email: { $regex: email, $options: "i" },
        })
        .toArray();

      if (!user) return res.status(404).send({ error: "User not found" });

      res.send(user);
    });

    // Get all pending riders
    app.get("/riders/pending", verifyToken, verifyAdmin, async (req, res) => {
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
    app.get("/riders/approved", verifyToken, verifyAdmin, async (req, res) => {
      try {
        const approvedRiders = await ridersCollection
          .find({ status: "active" })
          .toArray();
        res.send(approvedRiders);
      } catch (error) {
        res.status(500).send({ error: "Failed to fetch approved riders" });
      }
    });

    // Assign rider api
    app.get("/parcels/unassigned", async (req, res) => {
      try {
        const parcels = await parcelsCollection
          .find({
            payment_status: "paid",
            delivery_status: "not delivered",
          })
          .toArray();

        res.send(parcels);
      } catch (err) {
        res.status(500).send({ error: "Failed to fetch unassigned parcels" });
      }
    });

    // GET /riders/available?region=Chattogram
    app.get("/riders/available", async (req, res) => {
      const region = req.query.region;
      if (!region) return res.status(400).send({ error: "Region is required" });

      try {
        const riders = await ridersCollection
          .find({ region, status: "active" })
          .toArray();
        res.send(riders);
      } catch (error) {
        res.status(500).send({ error: "Failed to fetch riders" });
      }
    });

    // Get completed deliveries for rider
    app.get("/rider/completed", verifyToken, verifyToken, verifyRider, async (req, res) => {
      const { email } = req.query;

      try {
        const parcels = await parcelsCollection.find({
          riderEmail: email,
          delivery_status: "delivered",
        }).toArray();

        res.send(parcels);
      } catch (err) {
        console.error(err);
        res.status(500).send({ error: "Failed to fetch completed deliveries" });
      }
    });

    // earning for the rider
    app.get("/rider/earnings-raw", verifyToken, verifyTokenEmail, verifyRider, async (req, res) => {
      const email = req.query.email;

      try {
        const earnings = await earningsCollection
          .find({ riderEmail: email })
          .toArray();

        res.send(earnings);
      } catch (err) {
        res.status(500).send({ error: "Failed to fetch earnings" });
      }
    });

    // Save parcels to the mongodb
    app.post("/add-parcels", verifyToken, async (req, res) => {
      const data = req.body;
      const result = await parcelsCollection.insertOne(data);
      res.send(result);
    });

    // Creating payment intent for stripe
    app.post("/createPaymentIntent", verifyToken, async (req, res) => {
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
    });

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

    // Rider cashOut
    app.post("/rider/cashOut", verifyToken, verifyRider, async (req, res) => {
      const { parcelId, amount, riderEmail, riderName, trackingId } = req.body;

      if (!parcelId || !amount || !riderEmail || !riderName) {
        return res.status(400).send({ error: "Missing required cashout fields" });
      }

      try {
        const result = await earningsCollection.insertOne({
          trackingId,
          amount,
          riderEmail,
          riderName,
          cashOutDate: new Date(),
        });

        await parcelsCollection.updateOne(
          { _id: new ObjectId(parcelId) },
          { $set: { cashOut: true } }
        );

        res.send(result);
      } catch (err) {
        res.status(500).send({ error: "Cashout failed" });
      }
    });


    app.post("/payments", verifyToken, async (req, res) => {
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

    // Update role
    app.patch("/admin/role/:id", async (req, res) => {
      const { id } = req.params;
      const { role } = req.body;
      const result = await usersCollection.updateOne(
        { _id: new ObjectId(id) },
        { $set: { role } }
      );
      res.send(result);
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
        if (result.modifiedCount > 0 && riderEmail) {
          const userEmail = { email: riderEmail };
          const updateUserRole = {
            $set: { role: "rider" },
          };
          const roleResult = await usersCollection.updateOne(
            userEmail,
            updateUserRole
          );
        }
        res.send({ result, roleResult });
      } catch (err) {
        res.status(500).send({ error: "Failed to approve rider" });
      }
    });

    app.patch("/assign-rider", async (req, res) => {
      const { parcelId, riderId, riderName, riderEmail } = req.body;

      try {
        // 1. Update parcel
        const parcelResult = await parcelsCollection.updateOne(
          { _id: new ObjectId(parcelId) },
          {
            $set: {
              delivery_status: "rider assigned",
              riderName,
              riderEmail,
            },
          }
        );

        // 2. Update rider status to "collected"
        const riderResult = await ridersCollection.updateOne(
          { _id: new ObjectId(riderId) },
          {
            $set: {
              work_status: "collected",
            },
          }
        );

        res.send(parcelResult);
      } catch (err) {
        res.status(500).send({ error: "Assignment failed" });
      }
    });

    // Update delivery status for a parcel
    app.patch("/rider/update-delivery/:id", verifyToken, verifyRider, async (req, res) => {
      const id = req.params.id;
      const { status } = req.body;

      const updateFields = {
        delivery_status: status,
      };

      if (status === "in-transit") {
        updateFields.transit_at = new Date().toISOString();
      }

      if (status === "delivered") {
        updateFields.delivered_at = new Date().toISOString();
      }

      try {
        const result = await parcelsCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: { updateFields } }
        );
        res.send(result);
      } catch (err) {
        res.status(500).send({ error: "Failed to update delivery status" });
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
