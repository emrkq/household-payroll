# Household Payroll

A small self-hosted web app for paying domestic staff. The employer records workers and monthly pay, then prints or downloads an English PDF payslip. Workers can sign in to see their own payslips and request a salary advance.

## Features

- Payslips as A4 PDF (download or print), with name, ID card number, earnings, deductions and net pay in words
- Dashboard with monthly totals per worker
- Worker sign-in: each worker sees only their own payslips and salary chart
- Salary advance requests, approved or rejected by the employer, with a notice to the worker
- Arabic and English interface, day and night themes
- Country presets that set the currency (Qatar, Saudi Arabia, UAE, Kuwait, Bahrain, Oman, Jordan, Egypt)

## Run with Docker

```bash
docker compose up -d --build
```

Then open `http://<server>:8097`. The first visit asks you to choose the employer username and password.

Data is stored in `./data` on the host (mounted at `/data`). Back it up; it holds names, ID numbers and salaries.

## Security notes

- Serve it only on a private network, or put it behind HTTPS (for example a reverse proxy) before exposing it.
- Passwords are stored as scrypt hashes. Sessions last 12 hours.

## License

Roboto font files in `fonts/` are under the Apache License 2.0.
