# Generated manually

import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('core_users', '0002_serviceproviderprofile_jobs_completed_and_more'),
    ]

    operations = [
        # 1. Remove the old unique_together constraint
        migrations.AlterUniqueTogether(
            name='review',
            unique_together=set(),
        ),
        # 2. Add the 'job' OneToOneField to Review (nullable at first for migration safety)
        migrations.AddField(
            model_name='review',
            name='job',
            field=models.OneToOneField(
                null=True,
                on_delete=django.db.models.deletion.CASCADE,
                related_name='review',
                to='core_users.jobrequest',
            ),
        ),
        # 3. Add CANCELLED status to JobRequest (just altering the field choices)
        migrations.AlterField(
            model_name='jobrequest',
            name='status',
            field=models.CharField(
                choices=[
                    ('PENDING', 'Pending'),
                    ('NEGOTIATING', 'Negotiating'),
                    ('CONFIRMED', 'Confirmed'),
                    ('COMPLETED', 'Completed'),
                    ('CANCELLED', 'Cancelled'),
                ],
                default='PENDING',
                max_length=20,
            ),
        ),
    ]
