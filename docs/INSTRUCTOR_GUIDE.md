# Instructor guide: peer feedback app

This guide is for instructors who used TEAMMATES. Button and page names below are the exact words on screen.

## 1. Sign in

1. Open the app address your instructor or administrator gave you.
2. Enter your email and password. Click **Sign in**.
3. Accounts are made by the person who set up the app. If you do not have one, ask them. Their setup steps are in `docs/DEPLOY.md`, step 8.
4. If you forget your password, click **Forgot your password?**. A reset email is sent only if email is set up.

## 2. Create a course

1. On the home page, under "Your courses", click **Create a course**.
2. Fill in **Course code** and **Course name**. **Institute** is optional. Pick a **Time zone**.
3. Click **Create course**.

The course page has four tabs: **Sessions**, **Students**, **Instructors**, and **Settings**.

## 3. Add students

1. Open the **Students** tab. Click **Enroll students**.
2. Paste rows into the box, or click **Upload CSV file**. The columns are `Section, Team, Name, Email, Comments`. A header row is optional.
3. Only Name and Email are required. A blank Section becomes "Default Section". A blank Team becomes "Default Team".
4. Check the **Preview** table. The Result column shows any row with a problem.
5. Click **Enroll N students**, where N is the number of valid rows. If any row has an error, nothing is added.

If your TEAMMATES "Download Student List" file has these five column names, you can reuse it. Check the preview before you enroll. A sample file is at `docs/sample-roster.csv`.

Enrolling an email that is already in the course updates that student. To change one student, click **Edit** on their row. Click **New link** to make a new link for them; the old link stops working. Click **Delete** to remove a student.

## 4. Create a peer evaluation

1. Open the **Sessions** tab. Click **New session**.
2. In **Start from**, pick **Team peer feedback (point-based)**, **Team peer feedback (percentage-based)**, or **Session with my own questions**.
3. Type a session name, or leave it blank for the default name. Click **Create and edit**.
4. On the edit page, set **Opens**, **Closes**, and **Grace period**. Click **Save settings**.

The two team templates differ in one way:

- **Point-based:** each teammate gets 100 points for an equal share. A student who did about 10% more gives 110 points.
- **Percentage-based:** each teammate is rated as "Equal share", "Equal share + N%", or "Equal share - N%". The ratings for a team must add up to 100 times the team size.

## 5. Edit questions and who can see answers

On the session edit page, the **Questions** section lists each question. For each one you can click **Edit**, **Up**, **Down**, **Duplicate**, or **Delete**. Click **Add question** to make a new one.

In the question editor, you choose who answers about whom, and a **Visibility** setting. The visibility choices are:

1. Shown anonymously to the recipient and the giver's team members. Visible to instructors.
2. Shown anonymously to the recipient. Visible to instructors.
3. Visible to the recipient and instructors.
4. Visible to instructors only.
5. Custom. This shows a grid of check boxes.

Instructors with permission to view results always see names. Hiding applies to students only.

Changing a question's type, choices, or who answers about whom deletes its existing answers. The screen asks you to confirm first.

## 6. Get the links to students

**Automatic email (needs email set up):** when a session opens, every student gets an email with their personal link. Under "Emails" on the edit page, you can also turn on **Closing soon (24 hours before)** and **Results published**. If email is not set up, no emails are sent and the app does not show an error.

**Without email:**

1. Open the **Students** tab.
2. Click **Download student links CSV**. The file has the columns `Section, Team, Name, Email, Link`.
3. Use a mail merge to send each student their link.

Treat this file like a list of passwords. Anyone with a link can submit for that student.

Students do not sign in. They can also click "email me my links" on the sign-in page to get their links sent to them.

## 7. Watch submissions, send reminders, extend deadlines, fix answers

1. On the **Sessions** tab, click **Status** next to the session.
2. The page shows how many students have responded, with a status and a deadline for each.
3. Select students with the check boxes. Use **Select non-submitters**, **Select all**, or **Clear**.
4. Click **Send submission reminder**. Click **Send results reminder** after results are published. Check **Send me a copy** to get a copy.
5. To extend a deadline, pick a date and time next to "Extended deadline for selected students," then click **Set extension**. Click **Remove extensions** to undo it. An extension must be later than the close time.
6. To fix a student's answers, click **Moderate** on their row. Changes save to that student's answers.
7. To see what a student sees, click **Preview**. Preview is read only.

Observers and tutors do not see the **Moderate** and **Preview** links.

## 8. See results, download them, publish them

1. On the **Status** page or the **Sessions** tab, open **Results**.
2. Choose **By question**, **By giver**, or **By recipient**. Filter by section with **All sections**.
3. Check **Show statistics** or **Show missing responses** if you want them.
4. Click **Download CSV** for a file of the answers.

To publish, click **Publish results** on the **Status** page. Click **Unpublish results** to hide them again. You can also set results to show "As soon as the session opens" or "At a set time" under "When students can see results."

Students open their own results page. It is titled "Results for" their name. It groups answers under "You gave," "About you," and "Others." Hidden names appear as "Anonymous." For the percentage-based question, the page shows "Your claim" and "Your team's view of you," with figures such as "Equal share + 10%."

## Differences from TEAMMATES

This app does not have these TEAMMATES features:

- Instructor comments on individual answers.
- Multiple choice and multiple select questions with weights, or a dropdown mode.
- Rich text. Answers are plain text with line breaks.
- Teams as the people who give feedback.
- Recipient groups limited to the same section.
- Section-level or session-level permission changes. There are four fixed roles: Co-owner, Manager, Observer, and Tutor.
- Custom roles.
- A recycle bin. Deletes are final.
- Emails to instructors when a session opens or closes.
- Emails to students when a deadline is extended.
- A visibility preset that hides giver names from instructors too. Instructors always see names.
- Student profiles.
- Students see their team's view of their own contribution (CONTRIB question) but not of their teammates', so that no one can work out a teammate's rating in a small team.
- Sign-in with Google, unless someone turns it on later.
