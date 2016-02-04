
Meteor.methods({

  list_deploys: function(host) {
    var fut = new Future();
    fs.exists('/opt/bixby/bin/bixby', function (exists) {
      if (!exists) {
        fut['return']([]);
        return;
      }
      var cmd = "/opt/bixby/bin/bixby run list_annotations deploy 'host=" + host + "'";
      exec(cmd, function (error, stdout, stderr) {
        var data = JSON.parse(stdout.toString());
        data.forEach(function(d) {
          try {
            d.detail = JSON.parse(d.detail);
          } catch (e) {
          }
        });
        fut['return'](data);
      });
    });
    return fut.wait();
  }

});
