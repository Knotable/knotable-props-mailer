Meteor.startup ->
  Deps.autorun -> #this autorun is triggered by Meteor.userId() reactive source. Be sure to not to add more unshielded reactive sources here.
    S3Credentials.requestCredentials()