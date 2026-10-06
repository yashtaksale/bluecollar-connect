from django.db import migrations, models

class Migration(migrations.Migration):

    dependencies = [
        ('core_users', '0005_jobrequest_scheduled_for_and_more'),
    ]

    operations = [
        migrations.AddField(
            model_name='jobrequest',
            name='provider_notes',
            field=models.TextField(blank=True, null=True),
        ),
    ]
