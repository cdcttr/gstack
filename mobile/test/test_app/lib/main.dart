import 'package:flutter/material.dart';

void main() {
  runApp(const TestFixtureApp());
}

class TestFixtureApp extends StatelessWidget {
  const TestFixtureApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'GStack Test Fixture',
      theme: ThemeData(
        colorSchemeSeed: Colors.blue,
        useMaterial3: true,
      ),
      home: const MainScreen(),
    );
  }
}

class MainScreen extends StatefulWidget {
  const MainScreen({super.key});

  @override
  State<MainScreen> createState() => _MainScreenState();
}

class _MainScreenState extends State<MainScreen> {
  int _selectedIndex = 0;

  @override
  void initState() {
    super.initState();
    print('App started');
  }

  final _screens = const [
    LoginScreen(),
    ListScreen(),
    SettingsScreen(),
  ];

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: _screens[_selectedIndex],
      bottomNavigationBar: NavigationBar(
        key: const Key('bottom_nav'),
        selectedIndex: _selectedIndex,
        onDestinationSelected: (index) {
          setState(() => _selectedIndex = index);
        },
        destinations: const [
          NavigationDestination(
            key: Key('nav_login'),
            icon: Icon(Icons.login),
            label: 'Login',
          ),
          NavigationDestination(
            key: Key('nav_list'),
            icon: Icon(Icons.list),
            label: 'List',
          ),
          NavigationDestination(
            key: Key('nav_settings'),
            icon: Icon(Icons.settings),
            label: 'Settings',
          ),
        ],
      ),
    );
  }
}

class LoginScreen extends StatelessWidget {
  const LoginScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.all(24.0),
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Semantics(
            label: 'Welcome header',
            child: Text(
              'Welcome Back',
              key: const Key('welcome_text'),
              style: Theme.of(context).textTheme.headlineMedium,
            ),
          ),
          const SizedBox(height: 32),
          Semantics(
            label: 'Email',
            child: TextField(
              key: const Key('email_field'),
              decoration: const InputDecoration(
                labelText: 'Email',
                border: OutlineInputBorder(),
              ),
              keyboardType: TextInputType.emailAddress,
            ),
          ),
          const SizedBox(height: 16),
          Semantics(
            label: 'Password',
            child: TextField(
              key: const Key('password_field'),
              decoration: const InputDecoration(
                labelText: 'Password',
                border: OutlineInputBorder(),
              ),
              obscureText: true,
            ),
          ),
          const SizedBox(height: 24),
          SizedBox(
            width: double.infinity,
            child: ElevatedButton(
              key: const Key('sign_in_button'),
              onPressed: () {
                print('Sign In tapped');
                ScaffoldMessenger.of(context).showSnackBar(
                  const SnackBar(content: Text('Sign in pressed')),
                );
              },
              child: const Text('Sign In'),
            ),
          ),
          const SizedBox(height: 12),
          TextButton(
            key: const Key('forgot_password_button'),
            onPressed: () => print('Forgot password tapped'),
            child: const Text('Forgot Password?'),
          ),
        ],
      ),
    );
  }
}

class ListScreen extends StatelessWidget {
  const ListScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        key: const Key('list_app_bar'),
        title: const Text('Items'),
      ),
      body: ListView.builder(
        key: const Key('item_list'),
        itemCount: 20,
        itemBuilder: (context, index) {
          return Semantics(
            label: 'Item $index',
            child: ListTile(
              key: Key('item_$index'),
              leading: CircleAvatar(child: Text('${index + 1}')),
              title: Text('Item $index'),
              subtitle: Text('Description for item $index'),
              onTap: () {
                Navigator.push(
                  context,
                  MaterialPageRoute(
                    builder: (_) => DetailScreen(itemIndex: index),
                  ),
                );
              },
            ),
          );
        },
      ),
    );
  }
}

class DetailScreen extends StatelessWidget {
  final int itemIndex;
  const DetailScreen({super.key, required this.itemIndex});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        key: const Key('detail_app_bar'),
        title: Text('Item $itemIndex'),
      ),
      body: Padding(
        padding: const EdgeInsets.all(24.0),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              'Item $itemIndex Details',
              key: const Key('detail_title'),
              style: Theme.of(context).textTheme.headlineSmall,
            ),
            const SizedBox(height: 16),
            Text(
              'This is the detail view for item $itemIndex.',
              key: const Key('detail_body'),
            ),
            const SizedBox(height: 24),
            ElevatedButton(
              key: const Key('detail_action_button'),
              onPressed: () => print('Detail action for item $itemIndex'),
              child: const Text('Take Action'),
            ),
          ],
        ),
      ),
    );
  }
}

class SettingsScreen extends StatefulWidget {
  const SettingsScreen({super.key});

  @override
  State<SettingsScreen> createState() => _SettingsScreenState();
}

class _SettingsScreenState extends State<SettingsScreen> {
  bool _darkMode = false;
  String _language = 'English';

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        key: const Key('settings_app_bar'),
        title: const Text('Settings'),
      ),
      body: ListView(
        children: [
          Semantics(
            label: 'Dark mode',
            child: SwitchListTile(
              key: const Key('dark_mode_switch'),
              title: const Text('Dark Mode'),
              subtitle: const Text('Enable dark theme'),
              value: _darkMode,
              onChanged: (value) {
                setState(() => _darkMode = value);
                print('Dark mode: $value');
              },
            ),
          ),
          Semantics(
            label: 'Language selector',
            child: ListTile(
              key: const Key('language_selector'),
              title: const Text('Language'),
              subtitle: Text(_language),
              trailing: DropdownButton<String>(
                value: _language,
                items: const [
                  DropdownMenuItem(value: 'English', child: Text('English')),
                  DropdownMenuItem(value: 'Spanish', child: Text('Spanish')),
                  DropdownMenuItem(value: 'French', child: Text('French')),
                ],
                onChanged: (value) {
                  setState(() => _language = value!);
                  print('Language: $value');
                },
              ),
            ),
          ),
          Semantics(
            label: 'Notifications toggle',
            child: SwitchListTile(
              key: const Key('notifications_switch'),
              title: const Text('Notifications'),
              subtitle: const Text('Enable push notifications'),
              value: true,
              onChanged: (value) => print('Notifications: $value'),
            ),
          ),
        ],
      ),
    );
  }
}
