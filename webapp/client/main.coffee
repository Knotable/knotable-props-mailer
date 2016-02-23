Meteor.startup ->
  # This autorun is triggered by Meteor.userId() reactive source.
  # Be sure to not to add more unshielded reactive sources here.
  Deps.autorun ->
    S3Credentials.requestCredentials()
