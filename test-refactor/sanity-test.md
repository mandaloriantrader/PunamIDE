# Punam Sanity Check Test

Open `app.py` in the editor, then ask these questions one by one.
Mark PASS or FAIL for each.

---

## Level 1: Basic Awareness

| # | Question | Expected Answer | Result |
|---|----------|-----------------|--------|
| 1 | "which file is open in the editor?" | app.py | |
| 2 | "what language is this file?" | Python | |
| 3 | "what's on line 1?" | `"""` (opening docstring) | |
| 4 | "what's on line 5?" | closing `"""` of the docstring | |

## Level 2: Reading Content (First 50 lines)

| # | Question | Expected Answer | Result |
|---|----------|-----------------|--------|
| 5 | "what's the first import in this file?" | `import json` | |
| 6 | "what is the value of DB_PATH?" | `"users.db"` | |
| 7 | "what's the name of the first function defined?" | `get_db` | |
| 8 | "list all the tables created in get_db" | users, sessions, audit_log | |

## Level 3: Understanding (No file reading needed)

| # | Question | Expected Answer | Result |
|---|----------|-----------------|--------|
| 9 | "what does this project do? one sentence." | User management API / authentication system | |
| 10 | "is there any security issue in this code?" | Should mention: silent email error swallowing, global DB connection, or password in plain text in email config | |

## Level 4: Deep File Reading (Past line 79 — WILL FAIL without fix)

| # | Question | Expected Answer | Result |
|---|----------|-----------------|--------|
| 11 | "how many functions are defined in this file?" | Should count all functions (register_user, login_user, get_user_profile, update_user_profile, change_password, admin_list_users, admin_deactivate_user, logout, cleanup_expired_sessions = 9+) | |
| 12 | "what's the last function in the file?" | `cleanup_expired_sessions` | |
| 13 | "is there a function called admin_deactivate_user?" | Yes | |
| 14 | "what does the logout function return on success?" | `{"success": True, "message": "Logged out"}` | |

## Level 5: Instruction Following

| # | Question | Expected Answer | Result |
|---|----------|-----------------|--------|
| 15 | "find the word 'magic' in this file. just tell me the line, don't change anything." | Should report line number(s) where "magic" appears in comments, NOT edit the file | |
| 16 | "count how many times the word 'session' appears" | Should give a number, not edit anything | |
| 17 | "add a comment '# TODO: refactor' on line 1. don't do anything else." | Should add ONLY that comment, not rewrite the file | |

## Level 6: Code Generation (Should always pass)

| # | Question | Expected Answer | Result |
|---|----------|-----------------|--------|
| 18 | "write a hello world in python, save as hello.py" | Creates hello.py with print("Hello, World!") | |
| 19 | "make a simple HTML page with a red button that says Click Me" | Creates an HTML file with a styled red button | |
| 20 | "explain what hashlib.pbkdf2_hmac does" | Explains password hashing with PBKDF2 | |

---

## Scoring

- **16-20 PASS:** Punam is working well
- **12-15 PASS:** Acceptable, file reading needs improvement
- **8-11 PASS:** Context truncation is the main issue (Level 4 failing)
- **Below 8:** Something is fundamentally broken

## Notes

- Level 4 tests will FAIL until the tool-use system is implemented or the context limit fix takes effect
- Level 5 tests check if she follows instructions (doesn't edit when asked to just read)
- Level 6 should always pass regardless of context issues (generative tasks)
