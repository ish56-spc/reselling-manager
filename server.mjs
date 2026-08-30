import "dotenv/config";
import express from "express";
import Database from "better-sqlite3";
import path from "path";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "10mb" }));
app.use(express.static("public"));

const db = new Database("reselling.db");

// ----------------------------------------------------
// DATABASE
// ----------------------------------------------------

db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS stock (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    generation TEXT NOT NULL,
    model_number TEXT,
    condition TEXT DEFAULT 'Working',
    quantity INTEGER NOT NULL DEFAULT 1,
    unit_cost REAL NOT NULL DEFAULT 0,
    cex_cash_value REAL DEFAULT 0,
    cex_voucher_value REAL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS sales (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sale_number INTEGER NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    paid_at TEXT,
    status TEXT NOT NULL DEFAULT 'Draft'
  );

  CREATE TABLE IF NOT EXISTS sale_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sale_id INTEGER NOT NULL,
    stock_id INTEGER NOT NULL,
    quantity INTEGER NOT NULL,
    sale_price_each REAL NOT NULL DEFAULT 0,
    returned_quantity INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (sale_id) REFERENCES sales(id),
    FOREIGN KEY (stock_id) REFERENCES stock(id)
  );
`);

// ----------------------------------------------------
// HELPERS
// ----------------------------------------------------

function nextSaleNumber() {
  const row = db
    .prepare("SELECT MAX(sale_number) AS max FROM sales")
    .get();

  return (row?.max || 0) + 1;
}

function now() {
  return new Date().toISOString();
}

// ----------------------------------------------------
// DASHBOARD
// ----------------------------------------------------

app.get("/api/dashboard", (req, res) => {
  try {
    const stock = db.prepare(`
      SELECT
        COALESCE(SUM(quantity), 0) AS units,
        COALESCE(SUM(quantity * unit_cost), 0) AS cost,
        COALESCE(SUM(quantity * cex_cash_value), 0) AS cexCash,
        COALESCE(SUM(quantity * cex_voucher_value), 0) AS cexVoucher
      FROM stock
    `).get();

    const sales = db.prepare(`
      SELECT
        COUNT(*) AS sales,
        COALESCE(SUM(
          (
            SELECT SUM(si.quantity * si.sale_price_each)
            FROM sale_items si
            WHERE si.sale_id = sales.id
          )
        ), 0) AS revenue
      FROM sales
      WHERE status = 'Paid'
    `).get();

    const profit = db.prepare(`
      SELECT COALESCE(SUM(
        (si.quantity - si.returned_quantity) *
        (si.sale_price_each - s.unit_cost)
      ), 0) AS profit
      FROM sale_items si
      JOIN sales sa ON sa.id = si.sale_id
      JOIN stock s ON s.id = si.stock_id
      WHERE sa.status = 'Paid'
    `).get();

    res.json({
      stock,
      sales,
      profit: profit.profit
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ----------------------------------------------------
// STOCK
// ----------------------------------------------------

app.get("/api/stock", (req, res) => {
  try {
    const search = String(req.query.search || "").trim();

    let rows;

    if (search) {
      rows = db.prepare(`
        SELECT *
        FROM stock
        WHERE
          name LIKE ?
          OR generation LIKE ?
          OR model_number LIKE ?
          OR condition LIKE ?
        ORDER BY id DESC
      `).all(
        `%${search}%`,
        `%${search}%`,
        `%${search}%`,
        `%${search}%`
      );
    } else {
      rows = db.prepare(`
        SELECT *
        FROM stock
        ORDER BY id DESC
      `).all();
    }

    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/stock", (req, res) => {
  try {
    const {
      name,
      generation,
      model_number,
      condition = "Working",
      quantity = 1,
      unit_cost = 0,
      cex_cash_value = 0,
      cex_voucher_value = 0
    } = req.body;

    if (!name || !generation) {
      return res.status(400).json({
        error: "Name and generation are required."
      });
    }

    if (quantity <= 0) {
      return res.status(400).json({
        error: "Quantity must be greater than zero."
      });
    }

    const result = db.prepare(`
      INSERT INTO stock (
        name,
        generation,
        model_number,
        condition,
        quantity,
        unit_cost,
        cex_cash_value,
        cex_voucher_value
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      name,
      generation,
      model_number || "",
      condition,
      Number(quantity),
      Number(unit_cost),
      Number(cex_cash_value),
      Number(cex_voucher_value)
    );

    res.json({
      success: true,
      id: result.lastInsertRowid
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ----------------------------------------------------
// CREATE SALE
// ----------------------------------------------------

app.post("/api/sales", (req, res) => {
  try {
    const saleNumber = nextSaleNumber();

    const result = db.prepare(`
      INSERT INTO sales (
        sale_number,
        created_at,
        status
      )
      VALUES (?, ?, 'Draft')
    `).run(saleNumber, now());

    res.json({
      success: true,
      id: result.lastInsertRowid,
      saleNumber
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ----------------------------------------------------
// SALES LIST
// ----------------------------------------------------

app.get("/api/sales", (req, res) => {
  try {
    const sales = db.prepare(`
      SELECT *
      FROM sales
      ORDER BY id DESC
    `).all();

    const result = sales.map((sale) => {
      const data = db.prepare(`
        SELECT
          COALESCE(SUM(si.quantity * si.sale_price_each), 0) AS revenue,
          COALESCE(SUM(
            (si.quantity - si.returned_quantity) *
            (si.sale_price_each - s.unit_cost)
          ), 0) AS profit,
          COALESCE(SUM(si.returned_quantity), 0) AS returned_units
        FROM sale_items si
        JOIN stock s ON s.id = si.stock_id
        WHERE si.sale_id = ?
      `).get(sale.id);

      return {
        ...sale,
        revenue: data.revenue,
        profit: data.profit,
        returned_units: data.returned_units
      };
    });

    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ----------------------------------------------------
// SINGLE SALE
// ----------------------------------------------------

app.get("/api/sales/:id", (req, res) => {
  try {
    const sale = db.prepare(`
      SELECT *
      FROM sales
      WHERE id = ?
    `).get(req.params.id);

    if (!sale) {
      return res.status(404).json({
        error: "Sale not found."
      });
    }

    const items = db.prepare(`
      SELECT
        si.*,
        s.name,
        s.generation,
        s.model_number,
        s.unit_cost
      FROM sale_items si
      JOIN stock s ON s.id = si.stock_id
      WHERE si.sale_id = ?
      ORDER BY si.id
    `).all(req.params.id);

    res.json({
      sale,
      items
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ----------------------------------------------------
// ADD ITEM TO SALE
// ----------------------------------------------------

app.post("/api/sales/:id/items", (req, res) => {
  try {
    const saleId = Number(req.params.id);
    const {
      stock_id,
      quantity,
      sale_price_each
    } = req.body;

    const sale = db.prepare(`
      SELECT *
      FROM sales
      WHERE id = ?
    `).get(saleId);

    if (!sale) {
      return res.status(404).json({
        error: "Sale not found."
      });
    }

    if (sale.status === "Paid") {
      return res.status(400).json({
        error: "Paid sales cannot be edited."
      });
    }

    const stock = db.prepare(`
      SELECT *
      FROM stock
      WHERE id = ?
    `).get(stock_id);

    if (!stock) {
      return res.status(404).json({
        error: "Stock item not found."
      });
    }

    const qty = Number(quantity);

    if (qty <= 0) {
      return res.status(400).json({
        error: "Quantity must be greater than zero."
      });
    }

    // How much of this stock row is already allocated
    const allocated = db.prepare(`
      SELECT COALESCE(SUM(quantity - returned_quantity), 0) AS amount
      FROM sale_items
      WHERE stock_id = ?
    `).get(stock_id);

    const available =
      stock.quantity - Number(allocated.amount || 0);

    if (qty > available) {
      return res.status(400).json({
        error: `Only ${available} available.`
      });
    }

    db.prepare(`
      INSERT INTO sale_items (
        sale_id,
        stock_id,
        quantity,
        sale_price_each,
        returned_quantity
      )
      VALUES (?, ?, ?, ?, 0)
    `).run(
      saleId,
      stock_id,
      qty,
      Number(sale_price_each)
    );

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ----------------------------------------------------
// REMOVE ITEM FROM DRAFT SALE
// ----------------------------------------------------

app.delete("/api/sales/items/:itemId", (req, res) => {
  try {
    const itemId = Number(req.params.itemId);

    const item = db.prepare(`
      SELECT
        si.*,
        sa.status
      FROM sale_items si
      JOIN sales sa ON sa.id = si.sale_id
      WHERE si.id = ?
    `).get(itemId);

    if (!item) {
      return res.status(404).json({
        error: "Sale item not found."
      });
    }

    if (item.status === "Paid") {
      return res.status(400).json({
        error: "Paid sales cannot be edited."
      });
    }

    db.prepare(`
      DELETE FROM sale_items
      WHERE id = ?
    `).run(itemId);

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ----------------------------------------------------
// MARK SALE AS PAID
// ----------------------------------------------------

app.post("/api/sales/:id/pay", (req, res) => {
  try {
    const saleId = Number(req.params.id);

    const items = db.prepare(`
      SELECT *
      FROM sale_items
      WHERE sale_id = ?
    `).all(saleId);

    if (items.length === 0) {
      return res.status(400).json({
        error: "You cannot pay an empty sale."
      });
    }

    db.prepare(`
      UPDATE sales
      SET
        status = 'Paid',
        paid_at = ?
      WHERE id = ?
    `).run(now(), saleId);

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ----------------------------------------------------
// CANCEL SALE
// ----------------------------------------------------

app.post("/api/sales/:id/cancel", (req, res) => {
  try {
    db.prepare(`
      UPDATE sales
      SET status = 'Cancelled'
      WHERE id = ?
    `).run(req.params.id);

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ----------------------------------------------------
// RETURNS
// ----------------------------------------------------

app.post("/api/sales/items/:itemId/return", (req, res) => {
  try {
    const itemId = Number(req.params.itemId);
    const quantity = Number(req.body.quantity);

    const item = db.prepare(`
      SELECT
        si.*,
        sa.status
      FROM sale_items si
      JOIN sales sa ON sa.id = si.sale_id
      WHERE si.id = ?
    `).get(itemId);

    if (!item) {
      return res.status(404).json({
        error: "Sale item not found."
      });
    }

    if (item.status !== "Paid") {
      return res.status(400).json({
        error: "Only paid sales can have returns."
      });
    }

    const remaining =
      item.quantity - item.returned_quantity;

    if (quantity <= 0 || quantity > remaining) {
      return res.status(400).json({
        error: `You can return between 1 and ${remaining}.`
      });
    }

    db.prepare(`
      UPDATE sale_items
      SET returned_quantity = returned_quantity + ?
      WHERE id = ?
    `).run(quantity, itemId);

    res.json({
      success: true,
      returned: quantity
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ----------------------------------------------------
// MONTHLY SALES
// ----------------------------------------------------

app.get("/api/monthly-sales", (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT
        strftime('%Y-%m', sa.created_at) AS month,
        COUNT(DISTINCT sa.id) AS sales,

        COALESCE(SUM(
          (si.quantity - si.returned_quantity)
          * si.sale_price_each
        ), 0) AS revenue,

        COALESCE(SUM(
          (si.quantity - si.returned_quantity)
          * (si.sale_price_each - s.unit_cost)
        ), 0) AS profit,

        COALESCE(SUM(si.returned_quantity), 0) AS returns

      FROM sales sa

      LEFT JOIN sale_items si
        ON si.sale_id = sa.id

      LEFT JOIN stock s
        ON s.id = si.stock_id

      WHERE sa.status = 'Paid'

      GROUP BY strftime('%Y-%m', sa.created_at)

      ORDER BY month DESC
    `).all();

    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ----------------------------------------------------
// START
// ----------------------------------------------------

app.listen(PORT, () => {
  console.log(`Reselling Manager running on port ${PORT}`);
});
