const express = require("express");
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const admin = require("firebase-admin");
const serviceAccount = require("./firebase-service-key.json");
require("dotenv").config();
const app = express();
const port = 3000;
app.use(cors());
app.use(express.json());

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});
/* -----------Firebase Token verify---------------- */
const verifyToken = async (req, res, next) => {
  const authorization = req.headers.authorization;
  if (!authorization) {
    res.status(401).send({
      message: "Unauthorized access. Token not found",
    });
  }
  const token = authorization.split(" ")[1];
  if (!token) {
    res.status(401).send({
      message: "Unauthorized access. Token not found",
    });
  }
  try {
    const decoderUser = await admin.auth().verifyIdToken(token);
    req.user = decoderUser;
    next();
  } catch {
    res.status(401).send({
      message: "Unauthorized access.",
    });
  }
};

const uri = `mongodb+srv://${process.env.DB_USERNAME}:${process.env.DB_PASSWORD}@cluster0.jdeeqhi.mongodb.net/?appName=Cluster0`;

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    await client.connect();

    const db = client.db("FinEase");
    const transactionCollection = db.collection("transactions");
    /* Add new transaction  */
    app.post("/transactions", verifyToken, async (req, res) => {
      const newTransaction = req.body;
      if (req.user.email !== newTransaction.email) {
        return res.status(403).send({ message: "Forbidden: Email mismatch." });
      }
      const result = await transactionCollection.insertOne(newTransaction);
      res.send(result);
    });
    /* get Transaction by user email   */
    app.get("/my-transactions", verifyToken, async (req, res) => {
      const email = req.query.email;
      if (req.user.email !== email) {
        return res.status(403).send({
          message: "Forbidden access",
        });
      }
      const result = await transactionCollection
        .find({
          email,
        })
        .toArray();
      res.send(result);
    });
    /* Get a Single Transaction by ID (with Category Total) */
    app.get("/transaction/:id", verifyToken, async (req, res) => {
      const { id } = req.params;
      const query = { _id: new ObjectId(id) };
      const transaction = await transactionCollection.findOne(query);
      if (!transaction) {
        return res.status(404).send({ message: "Transaction not found" });
      }
      if (transaction.email !== req.user.email) {
        return res
          .status(403)
          .send({ message: "Forbidden: You do not own this transaction" });
      }
      const pipeline = [
        {
          $match: {
            email: transaction.email,
            category: transaction.category,
            type: transaction.type,
          },
        },
        {
          $group: {
            _id: null,
            total: { $sum: "$amount" },
          },
        },
      ];
      const categoryTotalResult = await transactionCollection
        .aggregate(pipeline)
        .toArray();
      const categoryTotal =
        categoryTotalResult.length > 0 ? categoryTotalResult[0].total : 0;
      res.send({
        transaction,
        categoryTotal,
      });
    });
    /* delete a transaction by id and verify by email */
    app.delete("/transaction/:id", verifyToken, async (req, res) => {
      const { id } = req.params;
      const query = { _id: new ObjectId(id) };
      const transaction = await transactionCollection.findOne(query);
      if (!transaction) {
        return res.status(404).send({ message: "Transaction not found" });
      }
      if (transaction.email !== req.user.email) {
        return res
          .status(403)
          .send({ message: "Forbidden: Not your transaction" });
      }
      const result = await transactionCollection.deleteOne(query);
      res.send({ result, message: "Transaction deleted successfully" });
    });
    // PUT route: Update a transaction
    app.put("/transaction/:id", verifyToken, async (req, res) => {
      const { id } = req.params;
      const updatedData = req.body;
      const query = { _id: new ObjectId(id) };
      const transaction = await transactionCollection.findOne(query);
      if (!transaction) {
        return res.status(404).send({ message: "Transaction not found" });
      }
      if (transaction.email !== req.user.email) {
        return res
          .status(403)
          .send({ message: "Forbidden: You do not own this transaction" });
      }
      await transactionCollection.updateOne(query, { $set: updatedData });

      res.send({ message: "Transaction updated successfully" });
    });
    /* Total Overview for Balance , Income and Expense */
    app.get("/totalOverview", verifyToken, async (req, res) => {
      try {
        const userEmail = req.user.email;
        const pipeline = [
          {
            $match: { email: userEmail },
          },
          {
            $group: {
              _id: "$type",
              totalAmount: { $sum: "$amount" },
            },
          },
        ];
        const result = await transactionCollection
          .aggregate(pipeline)
          .toArray();
        let totalIncome = 0;
        let totalExpense = 0;

        result.forEach((item) => {
          if (item._id === "income") {
            totalIncome = item.totalAmount;
          } else if (item._id === "expense" || item._id === "expanse") {
            totalExpense = item.totalAmount;
          }
        });
        const totalBalance = totalIncome - totalExpense;
        res.send({
          totalIncome,
          totalExpense,
          totalBalance,
        });
      } catch (error) {
        console.error("Error fetching overview:", error);
        res.status(500).send({ message: "Failed to fetch overview data" });
      }
    });
    /* User Transaction report by category and monthly */
    app.get("/reports", verifyToken, async (req, res) => {
      const userEmail = req.query.email;
      if (req.user.email !== userEmail) {
        return res.status(403).send({ message: "Forbidden: Not your data" });
      }
      const transactions = await transactionCollection
        .find({ email: userEmail })
        .toArray();
      const categoryData = transactions.reduce((acc, tx) => {
        const existing = acc.find((item) => item.name === tx.category);
        if (existing) {
          existing.value += tx.amount;
        } else {
          acc.push({ name: tx.category, value: tx.amount });
        }
        return acc;
      }, []);
      const monthlyData = Array.from({ length: 12 }, (_, i) => {
        const monthIncome = transactions
          .filter(
            (tx) =>
              new Date(tx.date).getMonth() === i &&
              tx.type.toLowerCase() === "income")
          .reduce((sum, tx) => sum + tx.amount, 0);
        const monthExpense = transactions
          .filter(
            (tx) =>
              new Date(tx.date).getMonth() === i &&
              (tx.type.toLowerCase() === "expense" ||
                tx.type.toLowerCase() === "expanse")          )
          .reduce((sum, tx) => sum + tx.amount, 0);
        return {
          month: new Date(0, i).toLocaleString("default", { month: "short" }),
          income: monthIncome,
          expense: monthExpense,
        };
      });
      res.send({ categoryData, monthlyData });
    });
    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!"
    );
  } finally {
    // await client.close();
  }
}
run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("Server is running Fine.");
});

app.listen(port, () => {
  console.log(`Server is listening on port ${port}`);
});
