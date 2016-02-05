# DB params
ip="54.85.83.45"
dbname="alpha2"
username="knotable-alpha"
password="769TA9NHWL3M"
extraArgs="--authenticationDatabase admin"
month=$(date +'%Y-%m-%d' -d '-1 month')
lastmonth=$month'T00:00:00.000+0000'
day1=$(date -d "yesterday 13:00 " '+%Y-%m-%d')
day2=$(date +'%Y-%m-%d')
yesterday=$day1'T00:00:00.000+0000'
today=$day2'T00:00:00.000+0000'

# Email params
from="help@knote.com"
to="team@knote.com"
cc1="a@knote.com"
cc2="add@knotable.com"
cc3="richard@knote.com"
subject="Daily Knotable Stats -- $(date -d "yesterday 13:00 " '+%Y-%m-%d')"
apikey="key-ed04bdc21ac899b587517a9038f0639a"


totalusers=$(mongo ${extraArgs} --quiet ${ip}/${dbname} -u ${username} \
-p ${password} --eval "db.users.count()")

#Users who's last seen was in the past 30 days
activeusers=$(mongo ${extraArgs} --quiet ${ip}/${dbname} -u ${username} \
-p ${password} --eval 'db.users.count({ "last_seen": { "$gt": ISODate("'${lastmonth}'")}})')

userstoday=$(mongo ${extraArgs} --quiet ${ip}/${dbname} -u ${username} \
-p ${password} --eval 'db.users.count({ "last_seen": { "$gt": ISODate("'${yesterday}'"), "$lt": ISODate("'${today}'")}})')

signupstoday=$(mongo ${extraArgs} --quiet ${ip}/${dbname} -u ${username} \
-p ${password} --eval 'db.users.count({ "createdAt": { "$gt": ISODate("'${yesterday}'"), "$lt": ISODate("'${today}'")}})')

userswithpass=$(mongo ${extraArgs} --quiet ${ip}/${dbname} -u ${username} \
-p ${password} --eval 'db.users.count({ "services.password": { "$exists": true } })')

#total users with at least 3 pads
userswithpads=$(mongo ${extraArgs} --quiet ${ip}/${dbname} -u ${username} -p \
${password} --eval 'db.users.count({ "statistics.numberOfActivePads": { $gt: 2 } })')

totalpads=$(mongo ${extraArgs} --quiet ${ip}/${dbname} -u ${username} \
-p ${password} --eval 'db.topics.count()')

totalknotes=$(mongo ${extraArgs} --quiet ${ip}/${dbname} -u ${username} \
-p ${password} --eval 'db.knotes.count()')

#total replyByEmail events grouped by date_created (to second)
emailreplies=$(mongo ${extraArgs} --quiet ${ip}/${dbname} -u ${username} -p \
${password} --eval 'db.knotable_events.aggregate([ { $match: { "event_type": "replyByEmail" } }, { $group: { "_id": { month: { $month: "$date_created"}, day: { $dayOfMonth: "$date_created"}, year: { $year: "$date_created"}, hour: { $hour: "$date_created"}, minute: { $minute: "$date_created"}, second: { $second: "$date_created"}} } } ]).count()')

#contact usernames in contactAddedToPad event
contactadded=$(mongo ${extraArgs} --quiet ${ip}/${dbname} -u ${username} -p \
${password} --eval 'db.contacts.count()')

# Users last 30 days - $activeusers
# Users today - $userstoday

mongodata=$(cat template.txt)" $day1

Total Users - $totalusers
Signups - $signupstoday
Users with pass - $userswithpass
Users with more than 2 pads - $userswithpads
Reply by Email events - $emailreplies
Contacts added ever - $contactadded
Total pads - $totalpads
Total knotes - $totalknotes"

echo "Sending email..."
curl -s --user "api:${apikey}" \
  https://api.mailgun.net/v3/knotable.com/messages \
  -F from="${from}" \
  -F to="${to}" \
  -F cc="${cc1}, ${cc2}, ${cc3}" \
  -F subject="${subject}" \
  -F text="${mongodata}" \
