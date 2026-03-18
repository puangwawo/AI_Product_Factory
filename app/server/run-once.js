require('dotenv').config();
const { runAutomation } = require('./automation');

runAutomation()
  .then(({ keyword, product }) => {
    console.log('\n📦 Summary:');
    console.log(`   Keyword : ${keyword}`);
    console.log(`   Title   : ${product.title}`);
    process.exit(0);
  })
  .catch(err => {
    console.error('❌ Error:', err.message);
    process.exit(1);
  });
