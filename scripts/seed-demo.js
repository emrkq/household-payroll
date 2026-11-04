// Fills a data folder with example workers, payslips and advance requests so you can try the app.
// Usage: node scripts/seed-demo.js [data-folder]   (default: ./demo-data)
// Refuses to touch a folder that already has an employer account.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const dir = path.resolve(process.argv[2] || path.join(__dirname, "..", "demo-data"));
if (fs.existsSync(path.join(dir, "auth.json"))) {
  console.error(`${dir} already has an account. Choose an empty folder.`);
  process.exit(1);
}
fs.mkdirSync(dir, { recursive: true });

const hash = (pw) => { const salt = crypto.randomBytes(16).toString("hex"); return { salt, hash: crypto.scryptSync(pw, salt, 64).toString("hex") }; };
const write = (f, obj) => fs.writeFileSync(path.join(dir, f), JSON.stringify(obj, null, 1));

// Demo accounts (example values only)
const ADMIN = { username: "admin", password: "admin1234" };
const WORKER_PASSWORD = "worker1234";

const settings = { employer: "Al Noor Household", address: "West Bay, Doha, State of Qatar", phone: "+974 4000 0000",
  country: "QA", currency: "QAR", curName: "Qatari Riyals", subName: "Dirhams" };
const workers = [
  { id: "w1", name: "Maria Santos", nameAr: "ماريا سانتوس", idNo: "28460000001", nat: "Philippines", job: "Housemaid", passport: "P0000001A", join: "2023-02-01", salary: 1800, bank: "" },
  { id: "w2", name: "Siti Rahma", nameAr: "سيتي رحمة", idNo: "28460000002", nat: "Indonesia", job: "Nanny", passport: "B0000002", join: "2024-06-15", salary: 2000, bank: "" },
  { id: "w3", name: "Kamal Perera", nameAr: "كمال بيريرا", idNo: "28460000003", nat: "Sri Lanka", job: "Driver", passport: "N0000003", join: "2025-01-10", salary: 2500, bank: "" },
];

const year = new Date().getFullYear(), lastMonth = new Date().getMonth(); // payslips up to last month
const slips = [];
let no = 1;
for (let m = 1; m <= Math.max(lastMonth, 1); m++) {
  for (const w of workers) {
    const overtime = (m + w.salary / 100) % 3 === 0 ? 0 : 150;
    const advance = w.id === "w1" && m === 6 ? 300 : 0;
    const absence = w.id === "w3" && m === 4 ? 160 : 0;
    const earnings = [["Basic salary", w.salary], ["Housing allowance", 0], ["Food allowance", 300], ["Overtime", overtime], ["Bonus", m === 12 ? 500 : 0], ["Other earnings", 0]];
    const deductions = [["Salary advance", advance], ["Absence", absence], ["Other deductions", 0]];
    const gross = earnings.reduce((a, [, v]) => a + v, 0), ded = deductions.reduce((a, [, v]) => a + v, 0);
    const month = `${year}-${String(m).padStart(2, "0")}`;
    slips.unshift({ no: "PS-" + String(no++).padStart(5, "0"), created: `${month}-28T10:00:00Z`, month, days: "30", payDate: `${month}-28`,
      method: w.id === "w3" ? "Bank transfer" : "Cash", notes: advance ? "Salary advance of 300 deducted as agreed." : "",
      worker: { ...w }, earnings, deductions, gross, ded, net: gross - ded, currency: settings.currency, employer: { ...settings } });
  }
}

write("payroll.json", { settings, workers, slips, nextSlip: no });
write("auth.json", { username: ADMIN.username, ...hash(ADMIN.password) });
write("worker-auth.json", Object.fromEntries(workers.map(w => [w.id, hash(WORKER_PASSWORD)])));
const now = Date.now();
write("advance-requests.json", [
  { id: "r1", workerId: "w2", name: "Siti Rahma", idNo: "28460000002", amount: 500, reason: "School fees for my son", status: "pending", created: new Date(now - 864e5).toISOString() },
  { id: "r2", workerId: "w1", name: "Maria Santos", idNo: "28460000001", amount: 300, reason: "Family emergency", status: "approved",
    note: "Approved. It will be deducted next month.", created: new Date(now - 20 * 864e5).toISOString(), decided: new Date(now - 19 * 864e5).toISOString(), seen: false },
]);

console.log(`Demo data written to ${dir}
  Employer: ${ADMIN.username} / ${ADMIN.password}
  Workers:  ${workers.map(w => w.idNo).join(", ")} / ${WORKER_PASSWORD}`);
