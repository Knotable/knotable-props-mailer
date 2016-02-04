User Lists Dump and Email
==========================

Dump the users' lists of below category and mails to `team@knote.com`

1. People who were invited but were never active.
2. People who signed up but were never active
3. People who were active but god deactivated.
4. People who are active.

Trello: https://trello.com/c/eudvniFf/147-auto-mail-the-4-user-lists

## File Introduction

* ***export.sh***: Mail shell script to perform the dump and emailing
* ***template.txt***: Email body content. Date text is appended from the shell script

## Usage Example

    ./export.sh
    
Should dump the zip file and send email to `team@knote.com`


## Cron example

The below example will run the script on Sunday 8pm EDT. Assuming script is residing in `/opt/user_lists` and system time zone is `UTC`

  0 0 * * 1 cd /opt/user_lists && ./export.sh

*Author: Abhinav <in.abhi9@gmail.com>*