Meteor.methods
  requestCredentials: ->
    if Meteor.settings.AWS?
      crypto = Npm.require("crypto")
      # It is important to make sure that your policy document corresponds exactly to your S3 POST form.
      # If there are any discrepancies between the input field values in your form and the rule values in
      # your policy document, or if your form contains input fields that do not have corresponding rules in your policy,
      # the S3 service will reject the form and return an incomprehensible XML error message to your users.
      #
      # More reading if something is not clear:
      # http://docs.aws.amazon.com/AmazonS3/latest/API/sigv4-HTTPPOSTConstructPolicy.html
      # http://docs.aws.amazon.com/AmazonS3/latest/API/sigv4-post-example.html
      # http://docs.aws.amazon.com/AmazonS3/latest/API/sigv4-authentication-HTTPPOST.html
      # http://docs.aws.amazon.com/AmazonS3/latest/dev/s3-access-control.html
      expirationTimeout = moment.duration(1, "Hour")
      refreshTimeout = moment.duration(55, "Minutes")
      s3Policy = {
        "expiration": moment().add(expirationTimeout).toISOString()
        "conditions": [
          { "bucket": Meteor.settings.AWS.bucket },
          ["starts-with", "$key", "uploads/"],
          { "acl": "public-read" },
          {"success_action_status": "200"},
          ["starts-with", "$Content-Type", ""],
        ]
      };
      s3PolicyBase64 = new Buffer( JSON.stringify( s3Policy ) ).toString( 'base64' )
      return {
        s3_policy: s3PolicyBase64,
        s3_signature: crypto.createHmac( "sha1", Meteor.settings.AWS.secretAccessKey ).update( new Buffer(s3PolicyBase64, "utf-8") ).digest( "base64" ),
        s3_key: Meteor.settings.AWS.accessKeyId
        refreshTimeoutMilliseconds: refreshTimeout.asMilliseconds()
      }
    else
       throw new Meteor.Error 101, "AWS not defined"
